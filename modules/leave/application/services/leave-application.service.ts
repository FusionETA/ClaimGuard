import "server-only"

import { bustLeaveCaches } from "@/lib/cache-invalidation"
import { publishUserEvents } from "@/lib/realtime"
import { parseWorkingDays } from "@/modules/attendance/domain/hours-summary"
import {
  bookableDaysFor,
  computeTotalDays,
  forecastAccruedOnDate,
} from "@/modules/leave/domain/accrual"
import type {
  LeaveApplicationView,
  LeaveApprovalEntry,
  LeaveDuration,
  LeaveEntitlementView,
} from "@/modules/leave/domain/models"
import {
  getLeavePrismaClient,
  getLeavePrismaClientSafe,
  leaveRepository,
} from "@/modules/leave/infrastructure/leave-repository"
import {
  resolveLeaveApprovalContext,
  shouldAutoApproveLeave,
} from "@/modules/leave/infrastructure/leave-approval-context"

import {
  ensureEntitlement,
  listEmployeeBalances,
} from "./leave-entitlements.service"

/**
 * Compute the "effective available days" used to gate a leave
 * application. When the employee's org has
 * `allowForecastedLeaveApply = true` AND the leave type uses
 * `PRO_RATED` accrual, we substitute the live `accruedDays` for a
 * forecast computed at the leave's `startDate` — letting employees
 * apply for days that haven't accrued yet but WILL by then. Otherwise
 * the existing `balance.availableDays` is returned unchanged. Carried
 * (non-expired) days and used days are kept from the live row.
 *
 * Days already held by the employee's other PENDING requests are
 * subtracted too. Submitting doesn't move `usedDays` (only approval
 * does), so without this each request is checked in isolation and four
 * requests of 5+5+4+1 all pass against a 14-day entitlement. The
 * *displayed* balance deliberately still counts approved days only —
 * see `availableDaysFor` in domain/accrual.ts — because a pending
 * request may yet be rejected and shouldn't make days visibly vanish.
 * So "available to book" is legitimately lower than "available".
 *
 * Returns `{ available, forecasted, asOf, pendingDays }`: `forecasted`
 * true means the forecast path was taken and `pendingDays` is what
 * other pending requests are holding — both used by the caller to
 * phrase the error message.
 */
async function effectiveAvailableDaysFor(args: {
  employeeProfileId: string
  balance: LeaveEntitlementView
  startDate: Date
  /// The request being edited. Excluded from the pending total so it
  /// doesn't reserve days against itself — otherwise every edit fails
  /// once the balance is full.
  excludeApplicationId?: string
}): Promise<{
  available: number
  forecasted: boolean
  asOf: Date
  pendingDays: number
}> {
  const { balance, startDate } = args
  // Resolve pending BEFORE the accrual-method guard below: LUMP_SUM
  // types (most paid leave, annual included) return early, and if the
  // reservation were computed after that guard they'd never get one.
  //
  // `balance.year` rather than startDate's year: the caller resolved
  // `balance` from listEmployeeBalances(profileId, year) so they're
  // equal by construction, and using the row's own year guarantees the
  // pending window matches the entitlement being gated.
  const pending = await leaveRepository.sumPendingDays({
    employeeId: args.employeeProfileId,
    leaveTypeId: balance.leaveTypeId,
    year: balance.year,
    excludeApplicationId: args.excludeApplicationId,
  })
  const plain = {
    available: bookableDaysFor({
      availableDays: balance.availableDays,
      pendingDays: pending,
    }),
    forecasted: false as const,
    asOf: startDate,
    pendingDays: pending,
  }
  if (balance.accrualMethod !== "PRO_RATED") {
    return plain
  }
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) {
    return plain
  }
  const profile = await prisma.employeeProfile.findFirst({
    where: { id: args.employeeProfileId },
    select: {
      user: {
        select: {
          organization: { select: { allowForecastedLeaveApply: true } },
        },
      },
    },
  })
  const allowForecast =
    profile?.user.organization?.allowForecastedLeaveApply === true
  if (!allowForecast) {
    return plain
  }
  const joinDate = await leaveRepository.getEmployeeJoinDate(
    args.employeeProfileId,
  )
  const forecastedAccrued = forecastAccruedOnDate({
    entitledDays: balance.entitledDays,
    joinDate,
    asOf: startDate,
  })
  // Mirror availableDaysFor's PRO_RATED math, swapping accrued for
  // the forecasted value. Expired-carried days still don't count.
  const carry = balance.carriedExpired ? 0 : balance.carriedDays
  const available = bookableDaysFor({
    availableDays: forecastedAccrued + carry - balance.usedDays,
    pendingDays: pending,
  })
  return { available, forecasted: true, asOf: startDate, pendingDays: pending }
}

export type SubmitLeaveInput = {
  /// EmployeeProfile.id (NOT user.id) of the applicant.
  employeeProfileId: string
  leaveTypeId: string
  startDate: Date
  endDate: Date
  duration: LeaveDuration
  reason: string | null
  attachmentUrl?: string | null
  attachmentName?: string | null
  xeroFileId?: string | null
}

export type SubmitLeaveResult =
  | { ok: true; applicationId: string; status: "PENDING" | "APPROVED"; totalDays: number }
  | { ok: false; error: string }

/// Resolve the employee's org and bust its leave caches (on-leave-today
/// etc.). Leave applications are scoped by EmployeeProfile, so we hop
/// profile → user → organization. No-op when the org can't be resolved.
async function bustLeaveForProfile(employeeProfileId: string): Promise<void> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return
  const row = await prisma.employeeProfile.findFirst({
    where: { id: employeeProfileId },
    select: { user: { select: { organizationId: true } } },
  })
  const orgId = row?.user.organizationId
  if (orgId) await bustLeaveCaches({ organizationId: orgId })
}

/**
 * Push a live "refresh" SSE to every user id passed. Scope "leave" so
 * the RealtimeListener refreshes server components AND the shell's
 * pending-leave badge re-syncs. Never throws — realtime is best-effort
 * and must not break the underlying submit / decide transaction.
 */
async function publishLeaveRefresh(userIds: Array<string | null | undefined>) {
  const targets = userIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  )
  if (targets.length === 0) return
  try {
    await publishUserEvents(targets, { type: "refresh", scope: "leave" })
  } catch {
    // Realtime must never block the leave workflow.
  }
}

/**
 * Resolve the user ids of the approvers who can currently act on a
 * PENDING leave application (the approvers at `currentStep`). Used to
 * nudge their queue + badge live when a new application lands or a
 * mid-chain step advances.
 */
async function currentStepApproverUserIds(args: {
  employeeUserId: string
  lastReviewerId: string | null
}): Promise<string[]> {
  const ctx = await resolveLeaveApprovalContext({
    employeeUserId: args.employeeUserId,
    status: "PENDING",
    lastReviewerId: args.lastReviewerId,
  })
  if (ctx.currentStep == null) return []
  const step = ctx.chain[ctx.currentStep - 1]
  if (!step) return []
  return step.approvers.map((a) => a.approverId)
}

async function workingDaysForEmployee(employeeProfileId: string): Promise<Set<number>> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return parseWorkingDays(null)
  // Prefer the employee's primary team/project working-days CSV; fall back
  // to a sensible default. Keep it simple — leave is org-wide so we don't
  // need project-scoped resolution like attendance.
  const profile = await prisma.employeeProfile.findFirst({
    where: { id: employeeProfileId },
    include: {
      user: { select: { organization: { select: { id: true } } } },
    },
  })
  if (!profile) return parseWorkingDays(null)
  // No explicit org-level working-days CSV today; default to Mon–Fri.
  return parseWorkingDays(null)
}

export async function submitLeaveApplication(
  input: SubmitLeaveInput,
  actorRole: string | null | undefined,
): Promise<SubmitLeaveResult> {
  if (input.endDate < input.startDate) {
    return { ok: false, error: "End date is before start date" }
  }
  if (
    (input.duration === "MORNING" || input.duration === "AFTERNOON") &&
    !sameDay(input.startDate, input.endDate)
  ) {
    return { ok: false, error: "Half-day leave must start and end on the same day" }
  }

  const workingDays = await workingDaysForEmployee(input.employeeProfileId)
  const totalDays = computeTotalDays(
    input.startDate,
    input.endDate,
    input.duration,
    workingDays,
  )
  if (totalDays <= 0) {
    return { ok: false, error: "Selected dates contain no working days" }
  }

  const year = input.startDate.getUTCFullYear()
  const entitlement = await ensureEntitlement(
    input.employeeProfileId,
    input.leaveTypeId,
    year,
  )

  // Balance check (skip for unpaid: still track usage but allow negative).
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return { ok: false, error: "Database not configured" }
  const leaveType = await prisma.leaveType.findUnique({
    where: { id: input.leaveTypeId },
  })
  if (!leaveType) return { ok: false, error: "Leave type not found" }
  if (leaveType.archivedAt) return { ok: false, error: "Leave type is archived" }

  if (leaveType.paid) {
    const balances = await listEmployeeBalances(input.employeeProfileId, year)
    const balance = balances.find((b) => b.leaveTypeId === input.leaveTypeId)
    if (!balance) return { ok: false, error: "No entitlement row for this leave type" }
    const eff = await effectiveAvailableDaysFor({
      employeeProfileId: input.employeeProfileId,
      balance,
      startDate: input.startDate,
    })
    if (totalDays > eff.available + 0.0001) {
      const rounded = Math.round(eff.available * 100) / 100
      // Their balance card still shows approved-only days, so without
      // this the refusal reads as a bug ("it says I have 14 left").
      const held =
        eff.pendingDays > 0
          ? ` (${eff.pendingDays} day(s) held by your pending requests)`
          : ""
      return {
        ok: false,
        error: eff.forecasted
          ? `Insufficient balance: requesting ${totalDays} day(s); even by your leave start date (${formatIsoDate(eff.asOf)}) you'll only have ${rounded} day(s) available.${held}`
          : `Insufficient balance: requesting ${totalDays} but only ${rounded} available${held}`,
      }
    }
  }

  // Resolve approval routing.
  const employeeUserId = await userIdFromProfile(input.employeeProfileId)
  const autoApprove = await shouldAutoApproveLeave({
    employeeUserId,
    role: actorRole,
  })

  const status = autoApprove ? "APPROVED" : "PENDING"
  const decidedAt = autoApprove ? new Date() : null
  const currentStep = autoApprove ? 0 : 1

  const app = await leaveRepository.createApplication({
    employeeId: input.employeeProfileId,
    leaveTypeId: input.leaveTypeId,
    startDate: input.startDate,
    endDate: input.endDate,
    duration: input.duration,
    totalDays,
    reason: input.reason,
    attachmentUrl: input.attachmentUrl ?? null,
    attachmentName: input.attachmentName ?? null,
    xeroFileId: input.xeroFileId ?? null,
    status,
    currentStep,
    decidedAt,
  })

  if (autoApprove) {
    await leaveRepository.addUsedDays(entitlement.id, totalDays)
  }

  await bustLeaveForProfile(input.employeeProfileId)

  // Live: nudge the first-step approvers so the new application appears
  // in their queue + increments their badge immediately, instead of
  // waiting for their next navigation. Skipped when auto-approved
  // (nothing pending anyone's review).
  if (!autoApprove) {
    const approverIds = await currentStepApproverUserIds({
      employeeUserId,
      lastReviewerId: null,
    })
    await publishLeaveRefresh(approverIds)
  }

  return { ok: true, applicationId: app.id, status, totalDays }
}

// ─── Admin apply on behalf ──────────────────────────────────────────────

export type AdminApplyLeaveInput = {
  /// EmployeeProfile.id of the employee the admin is filing for.
  employeeProfileId: string
  leaveTypeId: string
  startDate: Date
  endDate: Date
  duration: LeaveDuration
  reason: string | null
}

export type AdminApplyLeaveResult =
  | { ok: true; applicationId: string; totalDays: number }
  | { ok: false; error: string }

/**
 * Admin applies leave on behalf of an employee. Lands directly as
 * APPROVED — bypasses the supervisor chain because the admin already
 * has authority to grant. The originating admin's user id is recorded
 * on `LeaveApplication.appliedByAdminId` for audit + UI display, plus
 * a synthetic `ADMIN_APPLIED` entry is added to the `approvals` JSON
 * so the per-application history shows "Applied by admin" as the
 * decision actor.
 *
 * Balance handling mirrors the auto-approve branch of
 * `submitLeaveApplication`: usedDays is incremented on the
 * entitlement row. The same balance-sufficiency check runs first so
 * admins don't accidentally over-grant paid leave. Unpaid types
 * still track usage but allow negative balance.
 */
export async function applyLeaveOnBehalfOfEmployee(input: {
  adminUserId: string
  payload: AdminApplyLeaveInput
}): Promise<AdminApplyLeaveResult> {
  const { payload } = input
  if (payload.endDate < payload.startDate) {
    return { ok: false, error: "End date is before start date" }
  }
  if (
    (payload.duration === "MORNING" || payload.duration === "AFTERNOON") &&
    !sameDay(payload.startDate, payload.endDate)
  ) {
    return {
      ok: false,
      error: "Half-day leave must start and end on the same day",
    }
  }

  const workingDays = await workingDaysForEmployee(payload.employeeProfileId)
  const totalDays = computeTotalDays(
    payload.startDate,
    payload.endDate,
    payload.duration,
    workingDays,
  )
  if (totalDays <= 0) {
    return { ok: false, error: "Selected dates contain no working days" }
  }

  const year = payload.startDate.getUTCFullYear()
  const entitlement = await ensureEntitlement(
    payload.employeeProfileId,
    payload.leaveTypeId,
    year,
  )

  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return { ok: false, error: "Database not configured" }

  const leaveType = await prisma.leaveType.findUnique({
    where: { id: payload.leaveTypeId },
  })
  if (!leaveType) return { ok: false, error: "Leave type not found" }
  if (leaveType.archivedAt)
    return { ok: false, error: "Leave type is archived" }

  // Balance check — mirrors the employee-self path so admins can't
  // accidentally over-grant paid leave. Unpaid types track usage but
  // allow negative balance (same as employee-submit).
  if (leaveType.paid) {
    const balances = await listEmployeeBalances(payload.employeeProfileId, year)
    const balance = balances.find((b) => b.leaveTypeId === payload.leaveTypeId)
    if (!balance) {
      return { ok: false, error: "No entitlement row for this leave type" }
    }
    const eff = await effectiveAvailableDaysFor({
      employeeProfileId: payload.employeeProfileId,
      balance,
      startDate: payload.startDate,
    })
    if (totalDays > eff.available + 0.0001) {
      const rounded = Math.round(eff.available * 100) / 100
      const held =
        eff.pendingDays > 0
          ? ` (${eff.pendingDays} day(s) held by the employee's pending requests)`
          : ""
      return {
        ok: false,
        error: eff.forecasted
          ? `Insufficient balance: requesting ${totalDays} day(s); even by the leave start date (${formatIsoDate(eff.asOf)}) the employee will only have ${rounded} day(s) available.${held}`
          : `Insufficient balance: requesting ${totalDays} but only ${rounded} available${held}`,
      }
    }
  }

  // Synthetic approval entry so the per-application history tells
  // the truth: it was an admin act, not a supervisor decision. The
  // approver step "0" mirrors the auto-approve self-submit branch.
  // `LeaveApplication.appliedByAdminId` is the canonical signal for
  // "this was admin-applied"; the entry here just makes the
  // existing approval-history UI render the timestamp + actor.
  const approvalEntry: LeaveApprovalEntry = {
    step: 0,
    approverId: input.adminUserId,
    decidedAt: new Date().toISOString(),
    decision: "APPROVED",
    ...(payload.reason ? { notes: payload.reason } : {}),
  }

  const app = await leaveRepository.createApplication({
    employeeId: payload.employeeProfileId,
    leaveTypeId: payload.leaveTypeId,
    startDate: payload.startDate,
    endDate: payload.endDate,
    duration: payload.duration,
    totalDays,
    reason: payload.reason,
    attachmentUrl: null,
    attachmentName: null,
    xeroFileId: null,
    status: "APPROVED",
    currentStep: 0,
    decidedAt: new Date(),
    appliedByAdminId: input.adminUserId,
    approvals: [approvalEntry],
  })

  await leaveRepository.addUsedDays(entitlement.id, totalDays)
  await bustLeaveForProfile(payload.employeeProfileId)

  return { ok: true, applicationId: app.id, totalDays }
}

export type EditLeaveInput = {
  applicationId: string
  /// The user (User.id, not EmployeeProfile.id) submitting the edit.
  /// Must match the application owner — enforced server-side.
  actorUserId: string
  leaveTypeId: string
  startDate: Date
  endDate: Date
  duration: LeaveDuration
  reason: string | null
  /// When undefined: keep the existing attachment unchanged.
  /// When provided (even as nulls): replace with this new attachment
  /// (or clear it, when all three are null).
  attachment?: {
    attachmentUrl: string | null
    attachmentName: string | null
    xeroFileId: string | null
  }
}

/// Edit a PENDING leave application. Allowed only when:
///   - the actor owns the application
///   - status is PENDING and no approver has acted yet (approvals array
///     is empty / no entries). Once any reviewer approves or rejects a
///     step, the application is locked from further edits.
///
/// Recomputes totalDays and re-runs balance/half-day validation. Does
/// NOT mutate the approval chain — the application stays at step 1 with
/// status PENDING after a successful edit.
export async function editLeaveApplication(
  input: EditLeaveInput,
): Promise<{ ok: true; totalDays: number } | { ok: false; error: string }> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return { ok: false, error: "Database not configured" }

  const app = await leaveRepository.getApplication(input.applicationId)
  if (!app) return { ok: false, error: "Application not found" }
  if (app.employee.user.id !== input.actorUserId) {
    return { ok: false, error: "You can only edit your own leave" }
  }
  if (app.status !== "PENDING") {
    return { ok: false, error: "Only pending leave can be edited" }
  }
  const approvals = Array.isArray(app.approvals)
    ? (app.approvals as unknown as LeaveApprovalEntry[])
    : []
  if (approvals.length > 0) {
    return { ok: false, error: "Cannot edit — an approver has already reviewed this leave" }
  }

  if (input.endDate < input.startDate) {
    return { ok: false, error: "End date is before start date" }
  }
  if (
    (input.duration === "MORNING" || input.duration === "AFTERNOON") &&
    !sameDay(input.startDate, input.endDate)
  ) {
    return { ok: false, error: "Half-day leave must start and end on the same day" }
  }

  const workingDays = await workingDaysForEmployee(app.employeeId)
  const totalDays = computeTotalDays(input.startDate, input.endDate, input.duration, workingDays)
  if (totalDays <= 0) {
    return { ok: false, error: "Selected dates contain no working days" }
  }

  const year = input.startDate.getUTCFullYear()
  const newType = await prisma.leaveType.findUnique({
    where: { id: input.leaveTypeId },
  })
  if (!newType) return { ok: false, error: "Leave type not found" }
  if (newType.archivedAt) return { ok: false, error: "Leave type is archived" }

  // Balance check uses the *new* leave type. The application hasn't
  // touched usedDays (it's still PENDING), but it IS reserving days via
  // the pending total — so exclude it, or resizing a request would be
  // measured against itself and every edit would fail on a full balance.
  if (newType.paid) {
    const balances = await listEmployeeBalances(app.employeeId, year)
    const balance = balances.find((b) => b.leaveTypeId === input.leaveTypeId)
    if (!balance) return { ok: false, error: "No entitlement row for this leave type" }
    const eff = await effectiveAvailableDaysFor({
      employeeProfileId: app.employeeId,
      balance,
      startDate: input.startDate,
      excludeApplicationId: input.applicationId,
    })
    if (totalDays > eff.available + 0.0001) {
      const rounded = Math.round(eff.available * 100) / 100
      const held =
        eff.pendingDays > 0
          ? ` (${eff.pendingDays} day(s) held by your other pending requests)`
          : ""
      return {
        ok: false,
        error: eff.forecasted
          ? `Insufficient balance: requesting ${totalDays} day(s); even by your leave start date (${formatIsoDate(eff.asOf)}) you'll only have ${rounded} day(s) available.${held}`
          : `Insufficient balance: requesting ${totalDays} but only ${rounded} available${held}`,
      }
    }
  }

  await prisma.leaveApplication.update({
    where: { id: input.applicationId },
    data: {
      leaveTypeId: input.leaveTypeId,
      startDate: input.startDate,
      endDate: input.endDate,
      duration: input.duration,
      totalDays,
      reason: input.reason,
      ...(input.attachment
        ? {
            attachmentUrl: input.attachment.attachmentUrl,
            attachmentName: input.attachment.attachmentName,
            xeroFileId: input.attachment.xeroFileId,
          }
        : {}),
    },
  })

  await bustLeaveForProfile(app.employeeId)
  return { ok: true, totalDays }
}

export async function decideLeaveApplication(args: {
  applicationId: string
  reviewerUserId: string
  decision: "APPROVED" | "REJECTED"
  notes?: string
}): Promise<{ ok: true; status: "PENDING" | "APPROVED" | "REJECTED" } | { ok: false; error: string }> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return { ok: false, error: "Database not configured" }

  const app = await leaveRepository.getApplication(args.applicationId)
  if (!app) return { ok: false, error: "Application not found" }
  if (app.status !== "PENDING") return { ok: false, error: "Application is not pending" }

  const employeeUserId = app.employee.user.id
  const ctx = await resolveLeaveApprovalContext({
    employeeUserId,
    status: "PENDING",
    lastReviewerId: (Array.isArray(app.approvals) && app.approvals.length > 0
      ? (app.approvals[app.approvals.length - 1] as LeaveApprovalEntry).approverId
      : null),
  })

  // Validate reviewer is at the current step.
  const stepIdx = (ctx.currentStep ?? 1) - 1
  const stepDef = ctx.chain[stepIdx]
  if (!stepDef || !stepDef.approvers.some((a) => a.approverId === args.reviewerUserId)) {
    return { ok: false, error: "You are not authorized to review this step" }
  }

  const prevApprovals: LeaveApprovalEntry[] = Array.isArray(app.approvals)
    ? (app.approvals as unknown as LeaveApprovalEntry[])
    : []
  const newEntry: LeaveApprovalEntry = {
    step: ctx.currentStep ?? 1,
    approverId: args.reviewerUserId,
    decision: args.decision,
    decidedAt: new Date().toISOString(),
    notes: args.notes,
  }
  const approvals = [...prevApprovals, newEntry]

  // Reject = terminal.
  if (args.decision === "REJECTED") {
    await leaveRepository.updateApplicationStatus(
      args.applicationId,
      "REJECTED",
      app.currentStep,
      approvals,
      new Date(),
    )
    await bustLeaveForProfile(app.employeeId)
    // Live: refresh the employee (their application list shows the
    // rejection) and the reviewer themselves (badge decrements as the
    // item leaves their queue).
    await publishLeaveRefresh([employeeUserId, args.reviewerUserId])
    return { ok: true, status: "REJECTED" }
  }

  // Approve — advance step. If past last step, finalise.
  const nextStep = (ctx.currentStep ?? 1) + 1
  const finalised = nextStep > ctx.chain.length
  const newStatus = finalised ? "APPROVED" : "PENDING"
  const decidedAt = finalised ? new Date() : null
  await leaveRepository.updateApplicationStatus(
    args.applicationId,
    newStatus,
    finalised ? app.currentStep : nextStep,
    approvals,
    decidedAt,
  )
  if (finalised) {
    // Decrement balance: ensure entitlement row exists, add used days.
    const ent = await ensureEntitlement(
      app.employeeId,
      app.leaveTypeId,
      app.startDate.getUTCFullYear(),
    )
    await leaveRepository.addUsedDays(ent.id, app.totalDays)
  }
  await bustLeaveForProfile(app.employeeId)

  // Live refresh targets: always the employee (their list reflects the
  // new status) and the reviewer (their badge decrements). When the
  // chain advances to another step, also nudge the next-step approvers
  // so the item lands in their queue live.
  const refreshTargets = [employeeUserId, args.reviewerUserId]
  if (!finalised) {
    const nextApprovers = await currentStepApproverUserIds({
      employeeUserId,
      lastReviewerId: args.reviewerUserId,
    })
    refreshTargets.push(...nextApprovers)
  }
  await publishLeaveRefresh(refreshTargets)

  return { ok: true, status: newStatus }
}

/// Withdraw one's own leave request. PENDING only — see below.
///
/// Cancelling a PENDING request moves no balance: submitting never
/// incremented `usedDays` (only approval does), so there is nothing to
/// give back. It does free the days the request was holding against the
/// pending reservation, because `sumPendingDays` filters on status and a
/// CANCELLED row simply drops out of it.
///
/// APPROVED leave deliberately can't be self-cancelled. That returns
/// days somebody already granted — and, with no date guard here, days
/// the employee may already have taken. It belongs behind an approval
/// flow (request → supervisor reviews → days return), not a button.
export async function cancelLeaveApplication(
  applicationId: string,
  actorUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const app = await leaveRepository.getApplication(applicationId)
  if (!app) return { ok: false, error: "Application not found" }
  if (app.employee.user.id !== actorUserId) {
    return { ok: false, error: "Only the applicant can cancel" }
  }
  // Idempotent: a double-click must not error.
  if (app.status === "CANCELLED") return { ok: true }
  if (app.status !== "PENDING") {
    return { ok: false, error: "Only pending leave can be cancelled" }
  }
  const approvals: LeaveApprovalEntry[] = Array.isArray(app.approvals)
    ? (app.approvals as unknown as LeaveApprovalEntry[])
    : []

  // Resolve who currently has this in their queue BEFORE cancelling —
  // afterwards the chain no longer resolves to a pending step, and their
  // badge would keep the stale count until a manual reload.
  const employeeUserId = app.employee.user.id
  const lastReviewerId =
    approvals.length > 0 ? approvals[approvals.length - 1].approverId : null
  const approverUserIds = await currentStepApproverUserIds({
    employeeUserId,
    lastReviewerId,
  })

  await leaveRepository.updateApplicationStatus(
    applicationId,
    "CANCELLED",
    app.currentStep,
    approvals,
    new Date(),
  )
  await bustLeaveForProfile(app.employeeId)
  // Employee's own list, plus the approvers who no longer need to act.
  await publishLeaveRefresh([employeeUserId, ...approverUserIds])
  return { ok: true }
}

export async function listMyApplications(employeeProfileId: string): Promise<LeaveApplicationView[]> {
  return leaveRepository.listApplicationsForEmployee(employeeProfileId)
}

/// Same as `listMyApplications` but accepts a `User.id` and handles the
/// userId → employeeProfileId lookup internally. Pages and actions
/// should prefer this version so they don't have to touch Prisma to
/// resolve the profile id from a session.
///
/// Multi-org: pass `organizationId` so the applications belong to the
/// profile at the CURRENT active org.
export async function listMyApplicationsForUser(
  userId: string,
  organizationId?: string,
): Promise<LeaveApplicationView[]> {
  const profileId = await leaveRepository.findEmployeeProfileIdByUserId(
    userId,
    organizationId,
  )
  if (!profileId) return []
  return leaveRepository.listApplicationsForEmployee(profileId)
}

/// Lightweight count of pending leave applications where the given user is
/// the current approver. Used by the nav badge and supervisor dashboard
/// card. Implementation reuses the heavier list — leave applications are
/// low-volume so the chain-resolution cost is acceptable.
export async function countPendingApprovalsForReviewer(
  reviewerUserId: string,
): Promise<number> {
  const list = await listPendingApprovalsForReviewer(reviewerUserId)
  return list.length
}

/// Pending leave applications where the given user is on the current step
/// of the resolved approval chain. Used by the supervisor/admin
/// approvals queue.
export async function listPendingApprovalsForReviewer(
  reviewerUserId: string,
): Promise<LeaveApplicationView[]> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return []

  // Get the reviewer's organization to scope the query.
  const reviewer = await prisma.user.findUnique({
    where: { id: reviewerUserId },
    select: { organizationId: true, role: true },
  })
  if (!reviewer?.organizationId) return []

  // Fetch all pending leave applications in the reviewer's org.
  const pending = await prisma.leaveApplication.findMany({
    where: {
      status: "PENDING",
      employee: { user: { organizationId: reviewer.organizationId } },
    },
    include: {
      leaveType: true,
      employee: { include: { user: true } },
    },
    orderBy: { createdAt: "asc" },
  })

  // Filter to ones where the reviewer is on the current step.
  const queue: LeaveApplicationView[] = []
  for (const app of pending) {
    const ctx = await resolveLeaveApprovalContext({
      employeeUserId: app.employee.user.id,
      status: "PENDING",
      lastReviewerId:
        Array.isArray(app.approvals) && app.approvals.length > 0
          ? (app.approvals[app.approvals.length - 1] as LeaveApprovalEntry).approverId
          : null,
    })
    const stepIdx = (ctx.currentStep ?? 1) - 1
    const stepDef = ctx.chain[stepIdx]
    if (stepDef && stepDef.approvers.some((a) => a.approverId === reviewerUserId)) {
      queue.push({
        id: app.id,
        employeeId: app.employeeId,
        employeeName: app.employee.user.name,
        leaveTypeId: app.leaveTypeId,
        leaveTypeCode: app.leaveType.code,
        leaveTypeName: app.leaveType.name,
        paid: app.leaveType.paid,
        startDate: app.startDate,
        endDate: app.endDate,
        duration: app.duration as LeaveDuration,
        totalDays: app.totalDays,
        reason: app.reason,
        attachmentUrl: app.attachmentUrl,
        attachmentName: app.attachmentName,
        status: "PENDING",
        currentStep: ctx.currentStep ?? 1,
        approvals: Array.isArray(app.approvals)
          ? (app.approvals as unknown as LeaveApprovalEntry[])
          : [],
        createdAt: app.createdAt,
        decidedAt: null,
      })
    }
  }
  return queue
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  )
}

/// Format a Date as YYYY-MM-DD using UTC components — matches how
/// leave start/end dates are stored and avoids local-tz drift in
/// admin-visible error messages.
function formatIsoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

async function userIdFromProfile(profileId: string): Promise<string> {
  const prisma = getLeavePrismaClient()
  const profile = await prisma.employeeProfile.findFirst({
    where: { id: profileId },
    select: { userId: true },
  })
  if (!profile) throw new Error("Employee not found")
  return profile.userId
}
