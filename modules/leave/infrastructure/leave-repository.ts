import "server-only"

import { Prisma } from "@/generated/prisma/client"

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
  prorateFirstYear: boolean
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
    prorateFirstYear: row.prorateFirstYear,
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
   *
   * Multi-org: pass `organizationId` so a user with EmployeeProfiles
   * at multiple companies resolves to the profile at the CURRENT
   * active org. Omitting the filter falls back to the first profile
   * found (legacy single-org behaviour).
   */
  async findEmployeeProfileIdByUserId(
    userId: string,
    organizationId?: string,
  ): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.employeeProfile.findFirst({
      where: organizationId ? { userId, organizationId } : { userId },
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
    const row = await prisma.employeeProfile.findFirst({
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
    options?: { policyIdScope?: string[] | null },
  ): Promise<
    Array<{ id: string; policyId: string | null; name: string; email: string }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
    const rows = await prisma.employeeProfile.findMany({
      where: {
        user: { organizationId: orgId },
        ...(policyIdScope && policyIdScope.length > 0
          ? { policyId: { in: policyIdScope } }
          : {}),
      },
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
    const row = await prisma.employeeProfile.findFirst({
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
    options?: { policyIdScope?: string[] | null },
  ): Promise<
    Array<{
      employeeId: string
      leaveTypeId: string
      entitledDays: number
      accrualMethod: LeaveAccrualMethod | null
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
    const rows = await prisma.leaveEntitlement.findMany({
      where: {
        year,
        employee: {
          user: { organizationId: orgId },
          ...(policyIdScope && policyIdScope.length > 0
            ? { policyId: { in: policyIdScope } }
            : {}),
        },
      },
      select: {
        employeeId: true,
        leaveTypeId: true,
        entitledDays: true,
        accrualMethod: true,
      },
    })
    return rows.map((r) => ({
      employeeId: r.employeeId,
      leaveTypeId: r.leaveTypeId,
      entitledDays: r.entitledDays,
      accrualMethod: (r.accrualMethod ?? null) as LeaveAccrualMethod | null,
    }))
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
      prorateFirstYear?: boolean
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
      prorateFirstYear: boolean
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
  async listPolicyDefaults(orgId: string): Promise<
    Array<{
      policyId: string
      leaveTypeId: string
      defaultDays: number
      accrualMethod: LeaveAccrualMethod | null
    }>
  > {
    const prisma = requirePrisma()
    const rows = await prisma.policyLeaveEntitlement.findMany({
      where: {
        policy: { organizationId: orgId },
      },
      select: {
        policyId: true,
        leaveTypeId: true,
        defaultDays: true,
        accrualMethod: true,
      },
    })
    return rows.map((r) => ({
      policyId: r.policyId,
      leaveTypeId: r.leaveTypeId,
      defaultDays: r.defaultDays,
      accrualMethod: (r.accrualMethod ?? null) as LeaveAccrualMethod | null,
    }))
  },

  /**
   * Upsert a per-policy override. `defaultDays` and `accrualMethod` are
   * independent — pass `null` for a field to clear that override
   * (column goes to null) while leaving the other in place. Pass
   * `undefined` (i.e. omit) to leave the existing value alone.
   *
   * If the row doesn't exist yet and only `accrualMethod` is specified
   * with no `defaultDays`, we still need a `defaultDays` to insert with
   * — fall back to the leave type's own `defaultDays` so the row is
   * coherent.
   */
  async upsertPolicyDefault(
    orgId: string,
    policyId: string,
    leaveTypeId: string,
    patch: {
      defaultDays?: number
      accrualMethod?: LeaveAccrualMethod | null
    },
  ): Promise<void> {
    const prisma = requirePrisma()
    // Scope guards
    const [policy, type] = await Promise.all([
      prisma.employeePolicy.findFirst({
        where: { id: policyId, organizationId: orgId },
        select: { id: true },
      }),
      prisma.leaveType.findFirst({
        where: { id: leaveTypeId, organizationId: orgId },
        select: { id: true, defaultDays: true, code: true },
      }),
    ])
    if (!policy || !type) throw new Error("Policy or LeaveType not found in org")

    // ANNUAL-only constraint: reject any attempt to set PRO_RATED
    // (or non-LUMP_SUM) on a non-Annual type. Null is always allowed
    // — that just clears the policy-layer override.
    if (
      patch.accrualMethod !== undefined &&
      patch.accrualMethod !== null &&
      (type.code ?? "").trim().toUpperCase() !== "ANNUAL"
    ) {
      throw new Error(
        "Pro-rated accrual is only available for Annual Leave. Other leave types are lump-sum.",
      )
    }

    const createData: {
      policyId: string
      leaveTypeId: string
      defaultDays: number
      accrualMethod?: LeaveAccrualMethod | null
    } = {
      policyId,
      leaveTypeId,
      defaultDays: patch.defaultDays ?? type.defaultDays,
    }
    if (patch.accrualMethod !== undefined) {
      createData.accrualMethod = patch.accrualMethod
    }

    const updateData: {
      defaultDays?: number
      accrualMethod?: LeaveAccrualMethod | null
    } = {}
    if (patch.defaultDays !== undefined) updateData.defaultDays = patch.defaultDays
    if (patch.accrualMethod !== undefined) updateData.accrualMethod = patch.accrualMethod

    await prisma.policyLeaveEntitlement.upsert({
      where: { policyId_leaveTypeId: { policyId, leaveTypeId } },
      create: createData,
      update: updateData,
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
    /// Pass `null` to clear the override (column goes to null →
    /// resolver walks up to policy/type). Pass `undefined` to leave
    /// the existing value alone on update.
    accrualMethod?: LeaveAccrualMethod | null
  }) {
    const prisma = requirePrisma()

    // ANNUAL-only constraint: reject any attempt to set a non-null
    // (non-LUMP_SUM) method on a non-Annual leave type. Need to look
    // up the type to check — cheap, only runs on writes.
    if (input.accrualMethod !== undefined && input.accrualMethod !== null) {
      const type = await prisma.leaveType.findUnique({
        where: { id: input.leaveTypeId },
        select: { code: true },
      })
      if ((type?.code ?? "").trim().toUpperCase() !== "ANNUAL") {
        throw new Error(
          "Pro-rated accrual is only available for Annual Leave. Other leave types are lump-sum.",
        )
      }
    }

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
        ...(input.accrualMethod !== undefined
          ? { accrualMethod: input.accrualMethod }
          : {}),
      },
      update: {
        entitledDays: input.entitledDays,
        ...(input.carriedDays !== undefined ? { carriedDays: input.carriedDays } : {}),
        ...(input.accruedDays !== undefined ? { accruedDays: input.accruedDays } : {}),
        ...(input.carriedExpiresAt !== undefined ? { carriedExpiresAt: input.carriedExpiresAt } : {}),
        ...(input.accrualMethod !== undefined
          ? { accrualMethod: input.accrualMethod }
          : {}),
      },
    })
  },

  async listEntitlementsForEmployee(
    employeeId: string,
    year: number,
  ): Promise<LeaveEntitlementView[]> {
    const prisma = requirePrisma()
    const [rows, employee] = await Promise.all([
      prisma.leaveEntitlement.findMany({
        where: { employeeId, year },
        include: { leaveType: true },
      }),
      prisma.employeeProfile.findFirst({
        where: { id: employeeId },
        select: { policyId: true },
      }),
    ])
    // Load this employee's policy-layer method overrides in one shot
    // so we resolve the effective accrual method per row without N+1
    // queries. `employee.policyId` may be null for unassigned employees.
    const policyMethodIndex = new Map<string, LeaveAccrualMethod>()
    if (employee?.policyId && rows.length > 0) {
      const overrides = await prisma.policyLeaveEntitlement.findMany({
        where: {
          policyId: employee.policyId,
          leaveTypeId: { in: rows.map((r) => r.leaveTypeId) },
          accrualMethod: { not: null },
        },
        select: { leaveTypeId: true, accrualMethod: true },
      })
      for (const o of overrides) {
        if (o.accrualMethod) {
          policyMethodIndex.set(
            o.leaveTypeId,
            o.accrualMethod as LeaveAccrualMethod,
          )
        }
      }
    }
    return rows.map((r) => {
      const employeeMethod = (r.accrualMethod ?? null) as LeaveAccrualMethod | null
      const policyMethod = policyMethodIndex.get(r.leaveTypeId) ?? null
      // ANNUAL-only constraint: only Annual Leave can resolve to
      // PRO_RATED. See resolveAccrualMethod for the same gate.
      const isAnnual =
        (r.leaveType.code ?? "").trim().toUpperCase() === "ANNUAL"
      const effectiveMethod: LeaveAccrualMethod = !isAnnual
        ? "LUMP_SUM"
        : (employeeMethod ??
            policyMethod ??
            (r.leaveType.accrualMethod as LeaveAccrualMethod))
      return {
        id: r.id,
        employeeId: r.employeeId,
        leaveTypeId: r.leaveTypeId,
        leaveTypeCode: r.leaveType.code,
        leaveTypeName: r.leaveType.name,
        paid: r.leaveType.paid,
        accrualMethod: effectiveMethod,
        year: r.year,
        entitledDays: r.entitledDays,
        carriedDays: r.carriedDays,
        carriedExpiresAt: r.carriedExpiresAt,
        carriedExpired: r.carriedExpired,
        accruedDays: r.accruedDays,
        usedDays: r.usedDays,
        availableDays: 0, // service layer fills this
      }
    })
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
    /// Set when an admin applies leave on behalf of the employee.
    /// Null on the employee-self-submit path. Drives the "Applied by
    /// <admin>" tag in the audit log + the UI list.
    appliedByAdminId?: string | null
    /// Optional pre-built approvals JSON. Used by the admin-apply
    /// flow to record a single "ADMIN_APPLIED" entry so the audit
    /// trail is self-explanatory without a fake supervisor approval.
    approvals?: LeaveApprovalEntry[] | null
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
        appliedByAdminId: input.appliedByAdminId ?? null,
        ...(input.approvals && input.approvals.length > 0
          ? { approvals: input.approvals as unknown as Prisma.InputJsonValue }
          : {}),
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
  async countPendingForOrganization(
    organizationId: string,
    options?: { policyIdScope?: string[] | null },
  ): Promise<number> {
    const prisma = requirePrisma()
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return 0
    return prisma.leaveApplication.count({
      where: {
        status: "PENDING",
        employee: {
          user: { organizationId },
          ...(policyIdScope && policyIdScope.length > 0
            ? { policyId: { in: policyIdScope } }
            : {}),
        },
      },
    })
  },

  /**
   * Leave overlapping a date range for many employees at once, keyed by
   * the *user* id rather than the EmployeeProfile id so attendance code
   * can join it directly.
   *
   * Bulk form of `listApplicationsForEmployee` — the day-by-day
   * attendance export needs leave for every employee in scope, and
   * per-employee calls would be one query per person.
   */
  async listApplicationsInRangeForUsers(
    userIds: string[],
    from: Date,
    to: Date,
  ): Promise<
    Array<{
      userId: string
      leaveTypeName: string
      startDate: Date
      endDate: Date
      status: string
    }>
  > {
    if (userIds.length === 0) return []
    const prisma = requirePrisma()
    const rows = await prisma.leaveApplication.findMany({
      where: {
        employee: { userId: { in: userIds } },
        status: { in: ["APPROVED", "PENDING"] },
        startDate: { lte: to },
        endDate: { gte: from },
      },
      select: {
        startDate: true,
        endDate: true,
        status: true,
        leaveType: { select: { name: true } },
        employee: { select: { userId: true } },
      },
    })
    return rows.map((r) => ({
      userId: r.employee.userId,
      leaveTypeName: r.leaveType.name,
      startDate: r.startDate,
      endDate: r.endDate,
      status: r.status,
    }))
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
