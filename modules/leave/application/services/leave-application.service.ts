import "server-only"

import { bustLeaveCaches } from "@/lib/cache-invalidation"
import { parseWorkingDays } from "@/modules/attendance/domain/hours-summary"
import {
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
 * Returns `{ available, forecasted, asOf }`: `forecasted` true means
 * the forecast path was taken (used by the caller to phrase the
 * error message differently).
 */
async function effectiveAvailableDaysFor(args: {
  employeeProfileId: string
  balance: LeaveEntitlementView
  startDate: Date
}): Promise<{ available: number; forecasted: boolean; asOf: Date }> {
  const { balance, startDate } = args
  if (balance.accrualMethod !== "PRO_RATED") {
    return { available: balance.availableDays, forecasted: false, asOf: startDate }
  }
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) {
    return { available: balance.availableDays, forecasted: false, asOf: startDate }
  }
  const profile = await prisma.employeeProfile.findUnique({
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
    return { available: balance.availableDays, forecasted: false, asOf: startDate }
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
  const available = Math.max(0, forecastedAccrued + carry - balance.usedDays)
  return { available, forecasted: true, asOf: startDate }
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
  const row = await prisma.employeeProfile.findUnique({
    where: { id: employeeProfileId },
    select: { user: { select: { organizationId: true } } },
  })
  const orgId = row?.user.organizationId
  if (orgId) await bustLeaveCaches({ organizationId: orgId })
}

async function workingDaysForEmployee(employeeProfileId: string): Promise<Set<number>> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return parseWorkingDays(null)
  // Prefer the employee's primary team/project working-days CSV; fall back
  // to a sensible default. Keep it simple — leave is org-wide so we don't
  // need project-scoped resolution like attendance.
  const profile = await prisma.employeeProfile.findUnique({
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
      return {
        ok: false,
        error: eff.forecasted
          ? `Insufficient balance: requesting ${totalDays} day(s); even by your leave start date (${formatIsoDate(eff.asOf)}) you'll only have ${rounded} day(s) available.`
          : `Insufficient balance: requesting ${totalDays} but only ${rounded} available`,
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
  return { ok: true, applicationId: app.id, status, totalDays }
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

  // Balance check uses the *new* leave type. The old application hasn't
  // touched any balance yet (it's still PENDING — no usedDays increment).
  if (newType.paid) {
    const balances = await listEmployeeBalances(app.employeeId, year)
    const balance = balances.find((b) => b.leaveTypeId === input.leaveTypeId)
    if (!balance) return { ok: false, error: "No entitlement row for this leave type" }
    const eff = await effectiveAvailableDaysFor({
      employeeProfileId: app.employeeId,
      balance,
      startDate: input.startDate,
    })
    if (totalDays > eff.available + 0.0001) {
      const rounded = Math.round(eff.available * 100) / 100
      return {
        ok: false,
        error: eff.forecasted
          ? `Insufficient balance: requesting ${totalDays} day(s); even by your leave start date (${formatIsoDate(eff.asOf)}) you'll only have ${rounded} day(s) available.`
          : `Insufficient balance: requesting ${totalDays} but only ${rounded} available`,
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
  return { ok: true, status: newStatus }
}

export async function cancelLeaveApplication(
  applicationId: string,
  actorUserId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const app = await leaveRepository.getApplication(applicationId)
  if (!app) return { ok: false, error: "Application not found" }
  if (app.employee.user.id !== actorUserId) {
    return { ok: false, error: "Only the applicant can cancel" }
  }
  if (app.status === "CANCELLED") return { ok: true }
  if (app.status === "APPROVED") {
    // Restore balance.
    const ent = await ensureEntitlement(
      app.employeeId,
      app.leaveTypeId,
      app.startDate.getUTCFullYear(),
    )
    await leaveRepository.addUsedDays(ent.id, -app.totalDays)
  }
  const approvals: LeaveApprovalEntry[] = Array.isArray(app.approvals)
    ? (app.approvals as unknown as LeaveApprovalEntry[])
    : []
  await leaveRepository.updateApplicationStatus(
    applicationId,
    "CANCELLED",
    app.currentStep,
    approvals,
    new Date(),
  )
  await bustLeaveForProfile(app.employeeId)
  return { ok: true }
}

export async function listMyApplications(employeeProfileId: string): Promise<LeaveApplicationView[]> {
  return leaveRepository.listApplicationsForEmployee(employeeProfileId)
}

/// Same as `listMyApplications` but accepts a `User.id` and handles the
/// userId → employeeProfileId lookup internally. Pages and actions
/// should prefer this version so they don't have to touch Prisma to
/// resolve the profile id from a session.
export async function listMyApplicationsForUser(
  userId: string,
): Promise<LeaveApplicationView[]> {
  const profileId = await leaveRepository.findEmployeeProfileIdByUserId(userId)
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
  const profile = await prisma.employeeProfile.findUnique({
    where: { id: profileId },
    select: { userId: true },
  })
  if (!profile) throw new Error("Employee not found")
  return profile.userId
}
