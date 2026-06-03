import "server-only"

import { getPrismaClient } from "@/lib/prisma"

import type {
  LeaveAccrualMethod,
  LeaveApplicationView,
  LeaveApprovalEntry,
  LeaveDuration,
  LeaveEntitlementView,
  LeaveStatus,
  LeaveTypeView,
} from "../domain/models"

function requirePrisma() {
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Prisma client not configured")
  return prisma
}

/**
 * Module-scoped Prisma accessor for the leave module. Services in this
 * module call this instead of `getPrismaClient()` from `@/lib/prisma`,
 * so all leave-related DB access flows through the infrastructure layer
 * (which is what the layered-architecture rule actually cares about).
 *
 * Prefer adding a named repo method on `leaveRepository` for any query
 * that's used in more than one place — this accessor exists for
 * one-off, complex, or transactional reads that don't yet warrant a
 * dedicated method.
 *
 * Throws if the database isn't configured (e.g. local dev with no
 * `DATABASE_URL`) — callers that need graceful degradation should check
 * for that case before calling.
 */
export function getLeavePrismaClient() {
  return requirePrisma()
}

/**
 * Non-throwing variant. Returns `null` when the database isn't
 * configured, mirroring the original `getPrismaClient()` semantics.
 * Use this for read paths that want to render an empty state when the
 * DB is offline (e.g. local dev without a database).
 */
export function getLeavePrismaClientSafe() {
  return getPrismaClient()
}

function toLeaveType(row: {
  id: string
  code: string
  name: string
  paid: boolean
  accrualMethod: string
  defaultDays: number
  carryForward: boolean
  carryExpiryMonth: number | null
  maxCarryForwardDays: number | null
  archivedAt: Date | null
}): LeaveTypeView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    paid: row.paid,
    accrualMethod: row.accrualMethod as LeaveAccrualMethod,
    defaultDays: row.defaultDays,
    carryForward: row.carryForward,
    carryExpiryMonth: row.carryExpiryMonth,
    maxCarryForwardDays: row.maxCarryForwardDays,
    archivedAt: row.archivedAt,
  }
}

export const leaveRepository = {
  // -------------------------------------------------------------------------
  // Employee lookup
  // -------------------------------------------------------------------------
  /**
   * Resolve an employee's `EmployeeProfile.id` from their `User.id`.
   * Returns `null` if the user has no profile yet. Pages and routes
   * should call this through a service rather than reaching for
   * Prisma themselves.
   */
  async findEmployeeProfileIdByUserId(userId: string): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.employeeProfile.findUnique({
      where: { userId },
      select: { id: true },
    })
    return row?.id ?? null
  },

  /// Read the employee's joinDate from their PayrollProfile (the
  /// single source of truth for hire date). Returns null when no
  /// PayrollProfile or no joinDate is set. The leave-accrual code
  /// uses this to seed PRO_RATED entitlements with a join-date-aware
  /// backfill (see domain/accrual.ts → initialProRatedAccrual).
  async getEmployeeJoinDate(employeeProfileId: string): Promise<Date | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.employeeProfile.findUnique({
      where: { id: employeeProfileId },
      select: { payrollProfile: { select: { joinDate: true } } },
    })
    return row?.payrollProfile?.joinDate ?? null
  },

  /**
   * Lightweight employee list used by the leave settings page — just
   * profile id, policy id, name, email. Filtered to a single org.
   */
  async listEmployeesForLeaveSettings(
    orgId: string,
  ): Promise<
    Array<{ id: string; policyId: string | null; name: string; email: string }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.employeeProfile.findMany({
      where: { user: { organizationId: orgId } },
      orderBy: { user: { name: "asc" } },
      select: {
        id: true,
        policyId: true,
        user: { select: { name: true, email: true } },
      },
    })
    return rows.map((row) => ({
      id: row.id,
      policyId: row.policyId,
      name: row.user.name,
      email: row.user.email,
    }))
  },

  /**
   * Fetch a leave type's `code` scoped to an org. Returns null if the
   * type doesn't exist or belongs to a different org. Used by admin
   * actions to detect the protected built-in types.
   */
  async getLeaveTypeCodeForOrg(
    orgId: string,
    leaveTypeId: string,
  ): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.leaveType.findFirst({
      where: { id: leaveTypeId, organizationId: orgId },
      select: { code: true },
    })
    return row?.code ?? null
  },

  /**
   * Return the org id an EmployeeProfile belongs to (via its user).
   * Returns null when the profile doesn't exist. Used by admin actions
   * to scope-check that a target employee is in the admin's active org
   * before mutating their entitlement.
   */
  async getEmployeeOrgId(profileId: string): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.employeeProfile.findUnique({
      where: { id: profileId },
      select: { user: { select: { organizationId: true } } },
    })
    return row?.user.organizationId ?? null
  },

  /**
   * Per-employee leave-entitlement rows for an org × year, in the slim
   * shape the leave-settings page needs (employeeId, leaveTypeId,
   * entitledDays). The settings page uses this to show admin overrides
   * next to the policy defaults.
   */
  async listEmployeeEntitlementsForOrg(
    orgId: string,
    year: number,
  ): Promise<
    Array<{ employeeId: string; leaveTypeId: string; entitledDays: number }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.leaveEntitlement.findMany({
      where: {
        year,
        employee: { user: { organizationId: orgId } },
      },
      select: {
        employeeId: true,
        leaveTypeId: true,
        entitledDays: true,
      },
    })
    return rows
  },

  // -------------------------------------------------------------------------
  // Leave Types
  // -------------------------------------------------------------------------
  async listTypes(orgId: string, opts: { includeArchived?: boolean } = {}): Promise<LeaveTypeView[]> {
    const prisma = requirePrisma()
    const rows = await prisma.leaveType.findMany({
      where: {
        organizationId: orgId,
        ...(opts.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ archivedAt: "asc" }, { code: "asc" }],
    })
    return rows.map(toLeaveType)
  },

  async getType(orgId: string, id: string): Promise<LeaveTypeView | null> {
    const prisma = requirePrisma()
    const row = await prisma.leaveType.findFirst({
      where: { id, organizationId: orgId },
    })
    return row ? toLeaveType(row) : null
  },

  async createType(
    orgId: string,
    input: {
      code: string
      name: string
      paid: boolean
      accrualMethod: LeaveAccrualMethod
      defaultDays: number
      carryForward: boolean
      carryExpiryMonth: number | null
      maxCarryForwardDays: number | null
    },
  ): Promise<LeaveTypeView> {
    const prisma = requirePrisma()
    const row = await prisma.leaveType.create({
      data: { organizationId: orgId, ...input },
    })
    return toLeaveType(row)
  },

  async updateType(
    orgId: string,
    id: string,
    patch: Partial<{
      name: string
      paid: boolean
      accrualMethod: LeaveAccrualMethod
      defaultDays: number
      carryForward: boolean
      carryExpiryMonth: number | null
      maxCarryForwardDays: number | null
      archivedAt: Date | null
    }>,
  ): Promise<LeaveTypeView> {
    const prisma = requirePrisma()
    // Scope check
    const existing = await prisma.leaveType.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true },
    })
    if (!existing) throw new Error("LeaveType not found")
    const row = await prisma.leaveType.update({
      where: { id },
      data: patch,
    })
    return toLeaveType(row)
  },

  // -------------------------------------------------------------------------
  // Policy defaults
  // -------------------------------------------------------------------------
  async listPolicyDefaults(orgId: string): Promise<Array<{ policyId: string; leaveTypeId: string; defaultDays: number }>> {
    const prisma = requirePrisma()
    const rows = await prisma.policyLeaveEntitlement.findMany({
      where: {
        policy: { organizationId: orgId },
      },
      select: { policyId: true, leaveTypeId: true, defaultDays: true },
    })
    return rows
  },

  async upsertPolicyDefault(
    orgId: string,
    policyId: string,
    leaveTypeId: string,
    defaultDays: number,
  ): Promise<void> {
    const prisma = requirePrisma()
    // Scope guards
    const [policy, type] = await Promise.all([
      prisma.employeePolicy.findFirst({ where: { id: policyId, organizationId: orgId }, select: { id: true } }),
      prisma.leaveType.findFirst({ where: { id: leaveTypeId, organizationId: orgId }, select: { id: true } }),
    ])
    if (!policy || !type) throw new Error("Policy or LeaveType not found in org")

    await prisma.policyLeaveEntitlement.upsert({
      where: { policyId_leaveTypeId: { policyId, leaveTypeId } },
      create: { policyId, leaveTypeId, defaultDays },
      update: { defaultDays },
    })
  },

  async clearPolicyDefault(orgId: string, policyId: string, leaveTypeId: string): Promise<void> {
    const prisma = requirePrisma()
    const policy = await prisma.employeePolicy.findFirst({
      where: { id: policyId, organizationId: orgId },
      select: { id: true },
    })
    if (!policy) return
    await prisma.policyLeaveEntitlement
      .delete({ where: { policyId_leaveTypeId: { policyId, leaveTypeId } } })
      .catch(() => undefined)
  },

  // -------------------------------------------------------------------------
  // Entitlements (per employee × leaveType × year)
  // -------------------------------------------------------------------------
  async getEntitlement(
    employeeId: string,
    leaveTypeId: string,
    year: number,
  ) {
    const prisma = requirePrisma()
    return prisma.leaveEntitlement.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    })
  },

  async upsertEntitlement(input: {
    employeeId: string
    leaveTypeId: string
    year: number
    entitledDays: number
    carriedDays?: number
    accruedDays?: number
    carriedExpiresAt?: Date | null
  }) {
    const prisma = requirePrisma()
    return prisma.leaveEntitlement.upsert({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: input.employeeId,
          leaveTypeId: input.leaveTypeId,
          year: input.year,
        },
      },
      create: {
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        year: input.year,
        entitledDays: input.entitledDays,
        carriedDays: input.carriedDays ?? 0,
        accruedDays: input.accruedDays ?? 0,
        carriedExpiresAt: input.carriedExpiresAt ?? null,
      },
      update: {
        entitledDays: input.entitledDays,
        ...(input.carriedDays !== undefined ? { carriedDays: input.carriedDays } : {}),
        ...(input.accruedDays !== undefined ? { accruedDays: input.accruedDays } : {}),
        ...(input.carriedExpiresAt !== undefined ? { carriedExpiresAt: input.carriedExpiresAt } : {}),
      },
    })
  },

  async listEntitlementsForEmployee(
    employeeId: string,
    year: number,
  ): Promise<LeaveEntitlementView[]> {
    const prisma = requirePrisma()
    const rows = await prisma.leaveEntitlement.findMany({
      where: { employeeId, year },
      include: { leaveType: true },
    })
    return rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      leaveTypeId: r.leaveTypeId,
      leaveTypeCode: r.leaveType.code,
      leaveTypeName: r.leaveType.name,
      paid: r.leaveType.paid,
      accrualMethod: r.leaveType.accrualMethod as LeaveAccrualMethod,
      year: r.year,
      entitledDays: r.entitledDays,
      carriedDays: r.carriedDays,
      carriedExpiresAt: r.carriedExpiresAt,
      carriedExpired: r.carriedExpired,
      accruedDays: r.accruedDays,
      usedDays: r.usedDays,
      availableDays: 0, // service layer fills this
    }))
  },

  async addUsedDays(entitlementId: string, delta: number): Promise<void> {
    const prisma = requirePrisma()
    await prisma.leaveEntitlement.update({
      where: { id: entitlementId },
      data: { usedDays: { increment: delta } },
    })
  },

  // -------------------------------------------------------------------------
  // Applications
  // -------------------------------------------------------------------------
  async createApplication(input: {
    employeeId: string
    leaveTypeId: string
    startDate: Date
    endDate: Date
    duration: LeaveDuration
    totalDays: number
    reason: string | null
    attachmentUrl: string | null
    attachmentName: string | null
    xeroFileId: string | null
    status: LeaveStatus
    currentStep: number
    decidedAt: Date | null
  }) {
    const prisma = requirePrisma()
    return prisma.leaveApplication.create({
      data: {
        employeeId: input.employeeId,
        leaveTypeId: input.leaveTypeId,
        startDate: input.startDate,
        endDate: input.endDate,
        duration: input.duration,
        totalDays: input.totalDays,
        reason: input.reason,
        attachmentUrl: input.attachmentUrl,
        attachmentName: input.attachmentName,
        xeroFileId: input.xeroFileId,
        status: input.status,
        currentStep: input.currentStep,
        decidedAt: input.decidedAt,
      },
    })
  },

  /// Used by the Xero file proxy route to look up a leave application
  /// by its uploaded Xero file id (for permission checks).
  async getApplicationByXeroFileId(xeroFileId: string) {
    const prisma = requirePrisma()
    return prisma.leaveApplication.findFirst({
      where: { xeroFileId },
      include: {
        employee: { include: { user: true } },
      },
    })
  },

  async getApplication(id: string) {
    const prisma = requirePrisma()
    return prisma.leaveApplication.findUnique({
      where: { id },
      include: { leaveType: true, employee: { include: { user: true } } },
    })
  },

  async updateApplicationStatus(
    id: string,
    status: LeaveStatus,
    currentStep: number,
    approvals: LeaveApprovalEntry[],
    decidedAt: Date | null,
  ) {
    const prisma = requirePrisma()
    return prisma.leaveApplication.update({
      where: { id },
      data: {
        status,
        currentStep,
        approvals: approvals as unknown as object,
        decidedAt,
      },
    })
  },

  async listApplicationsForEmployee(employeeId: string): Promise<LeaveApplicationView[]> {
    const prisma = requirePrisma()
    const rows = await prisma.leaveApplication.findMany({
      where: { employeeId },
      include: { leaveType: true, employee: { include: { user: true } } },
      orderBy: [{ createdAt: "desc" }],
    })
    return rows.map(toApplicationView)
  },

  /**
   * Count leave applications in the org still awaiting a decision
   * (status PENDING). Drives the admin overview "Leave" quick-action
   * badge. Scoped via employee → user → organization.
   */
  async countPendingForOrganization(organizationId: string): Promise<number> {
    const prisma = requirePrisma()
    return prisma.leaveApplication.count({
      where: {
        status: "PENDING",
        employee: { user: { organizationId } },
      },
    })
  },

  async listApprovedPaidApplicationsInRange(
    employeeId: string,
    from: Date,
    to: Date,
  ) {
    const prisma = requirePrisma()
    return prisma.leaveApplication.findMany({
      where: {
        employeeId,
        status: "APPROVED",
        leaveType: { paid: true },
        startDate: { lte: to },
        endDate: { gte: from },
      },
      include: { leaveType: true },
    })
  },

  async listApprovedUnpaidApplicationsInRange(
    employeeId: string,
    from: Date,
    to: Date,
  ) {
    const prisma = requirePrisma()
    return prisma.leaveApplication.findMany({
      where: {
        employeeId,
        status: "APPROVED",
        leaveType: { paid: false },
        startDate: { lte: to },
        endDate: { gte: from },
      },
      include: { leaveType: true },
    })
  },
}

function toApplicationView(r: {
  id: string
  employeeId: string
  employee: { user: { name: string } }
  leaveTypeId: string
  leaveType: { code: string; name: string; paid: boolean }
  startDate: Date
  endDate: Date
  duration: string
  totalDays: number
  reason: string | null
  attachmentUrl: string | null
  attachmentName: string | null
  status: string
  currentStep: number
  approvals: unknown
  createdAt: Date
  decidedAt: Date | null
}): LeaveApplicationView {
  return {
    id: r.id,
    employeeId: r.employeeId,
    employeeName: r.employee.user.name,
    leaveTypeId: r.leaveTypeId,
    leaveTypeCode: r.leaveType.code,
    leaveTypeName: r.leaveType.name,
    paid: r.leaveType.paid,
    startDate: r.startDate,
    endDate: r.endDate,
    duration: r.duration as LeaveDuration,
    totalDays: r.totalDays,
    reason: r.reason,
    attachmentUrl: r.attachmentUrl,
    attachmentName: r.attachmentName,
    status: r.status as LeaveStatus,
    currentStep: r.currentStep,
    approvals: Array.isArray(r.approvals) ? (r.approvals as LeaveApprovalEntry[]) : [],
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  }
}
