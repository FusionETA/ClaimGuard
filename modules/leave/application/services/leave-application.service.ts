import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { parseWorkingDays } from "@/modules/attendance/domain/hours-summary"
import { computeTotalDays } from "@/modules/leave/domain/accrual"
import type {
  LeaveApplicationView,
  LeaveApprovalEntry,
  LeaveDuration,
} from "@/modules/leave/domain/models"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import {
  resolveLeaveApprovalContext,
  shouldAutoApproveLeave,
} from "@/modules/leave/infrastructure/leave-approval-context"

import {
  ensureEntitlement,
  listEmployeeBalances,
} from "./leave-entitlements.service"

export type SubmitLeaveInput = {
  /// EmployeeProfile.id (NOT user.id) of the applicant.
  employeeProfileId: string
  leaveTypeId: string
  startDate: Date
  endDate: Date
  duration: LeaveDuration
  reason: string | null
}

export type SubmitLeaveResult =
  | { ok: true; applicationId: string; status: "PENDING" | "APPROVED"; totalDays: number }
  | { ok: false; error: string }

async function workingDaysForEmployee(employeeProfileId: string): Promise<Set<number>> {
  const prisma = getPrismaClient()
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
  const prisma = getPrismaClient()
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
    if (totalDays > balance.availableDays + 0.0001) {
      return {
        ok: false,
        error: `Insufficient balance: requesting ${totalDays} but only ${balance.availableDays} available`,
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
    status,
    currentStep,
    decidedAt,
  })

  if (autoApprove) {
    await leaveRepository.addUsedDays(entitlement.id, totalDays)
  }

  return { ok: true, applicationId: app.id, status, totalDays }
}

export async function decideLeaveApplication(args: {
  applicationId: string
  reviewerUserId: string
  decision: "APPROVED" | "REJECTED"
  notes?: string
}): Promise<{ ok: true; status: "PENDING" | "APPROVED" | "REJECTED" } | { ok: false; error: string }> {
  const prisma = getPrismaClient()
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
  return { ok: true }
}

export async function listMyApplications(employeeProfileId: string): Promise<LeaveApplicationView[]> {
  return leaveRepository.listApplicationsForEmployee(employeeProfileId)
}

/// Pending leave applications where the given user is on the current step
/// of the resolved approval chain. Used by the supervisor/admin
/// approvals queue.
export async function listPendingApprovalsForReviewer(
  reviewerUserId: string,
): Promise<LeaveApplicationView[]> {
  const prisma = getPrismaClient()
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

async function userIdFromProfile(profileId: string): Promise<string> {
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database not configured")
  const profile = await prisma.employeeProfile.findUnique({
    where: { id: profileId },
    select: { userId: true },
  })
  if (!profile) throw new Error("Employee not found")
  return profile.userId
}
