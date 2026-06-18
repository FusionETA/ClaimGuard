import "server-only"

import { getPrismaClient } from "@/lib/prisma"

/**
 * Per-query Prisma row shapes returned by the executive-overview repository.
 * The service-layer aggregation code reads these and produces the user-facing
 * dashboard view models — keeping these separate means the service never has
 * to spell out a Prisma `select` clause.
 */

export type ExecMonthClaimRow = {
  amount: { toString(): string } | number | string
  project: { name: string } | null
  /// Employee's primary project — derived from their first
  /// `EmployeeProjectAssignment`. Used as a fallback for the Project
  /// claims breakdown when the claim's own `projectId` is null, so the
  /// card agrees with the detail dialog (which derives the same value
  /// via `resolvePrimaryProjectName`).
  employee: {
    employeeProfile: {
      projectAssignments: Array<{ project: { id: string; name: string } }>
    } | null
  } | null
}

export type ExecAttendanceRecordRow = {
  status: string
  project: string | null
  projectRef: { name: string } | null
}

export type ExecOtReviewedRow = {
  submittedAt: Date
  reviewedAt: Date | null
  reviewerId: string | null
  reviewer: { name: string } | null
}

export type ExecOtPendingRow = {
  employeeId: string
}

export type ExecStalePendingClaimRow = {
  id: string
  claimNumber: string
  title: string
  amount: { toString(): string } | number | string
  submittedAt: Date
  employee: { name: string } | null
}

export type ExecRunClaimRow = {
  amount: { toString(): string } | number | string
  status: string
}

export type ExecRejectedClaimRow = {
  id: string
  employeeId: string
  lastReviewerId: string | null
}

export type ExecChainStepRow = {
  employeeId: string
  step: number
  approverId: string
  approver: { id: string; name: string }
}

export const executiveOverviewRepository = {
  async getMonthClaimsForOrg(
    orgId: string,
    monthStart: Date,
    monthEnd: Date,
    options?: {
      restrictToEmployeeIds?: string[] | null
      paymentTypes?: Array<"PERSONAL" | "COMPANY">
    },
  ): Promise<ExecMonthClaimRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const scope = options?.restrictToEmployeeIds ?? null
    if (Array.isArray(scope) && scope.length === 0) return []
    const paymentTypes = options?.paymentTypes
    if (paymentTypes && paymentTypes.length === 0) return []
    return prisma.claim.findMany({
      where: {
        organizationId: orgId,
        submittedAt: { gte: monthStart, lte: monthEnd },
        status: { not: "REJECTED" },
        ...(scope ? { employeeId: { in: scope } } : {}),
        ...(paymentTypes && paymentTypes.length > 0
          ? { paymentType: { in: paymentTypes } }
          : {}),
      },
      select: {
        amount: true,
        // Prefer the claim's own projectId FK to XeroProject. When null
        // (legacy / admin-created rows), the service falls back to the
        // employee's primary project assignment so the Project claims
        // card agrees with the detail dialog.
        project: { select: { name: true } },
        employee: {
          select: {
            employeeProfile: {
              select: {
                projectAssignments: {
                  select: {
                    project: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        },
      },
    })
  },

  async getAttendanceRecordsForOrg(
    orgId: string,
    from: Date,
    to: Date,
    options?: { restrictToEmployeeIds?: string[] | null },
  ): Promise<ExecAttendanceRecordRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const scope = options?.restrictToEmployeeIds ?? null
    if (Array.isArray(scope) && scope.length === 0) return []
    return prisma.attendanceRecord.findMany({
      where: {
        date: { gte: from, lte: to },
        employee: { organizationId: orgId },
        ...(scope ? { employeeId: { in: scope } } : {}),
      },
      select: {
        status: true,
        project: true,
        projectRef: { select: { name: true } },
      },
    })
  },

  async getReviewedOtApprovalsForOrg(
    orgId: string,
    since: Date,
    options?: { restrictToEmployeeIds?: string[] | null },
  ): Promise<ExecOtReviewedRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const scope = options?.restrictToEmployeeIds ?? null
    if (Array.isArray(scope) && scope.length === 0) return []
    return prisma.approvalRequest.findMany({
      where: {
        kind: "OT",
        reviewerId: { not: null },
        reviewedAt: { not: null, gte: since },
        employee: { organizationId: orgId },
        ...(scope ? { employeeId: { in: scope } } : {}),
      },
      select: {
        submittedAt: true,
        reviewedAt: true,
        reviewerId: true,
        reviewer: { select: { name: true } },
      },
    })
  },

  async getPendingOtApprovalsForOrg(
    orgId: string,
    options?: { restrictToEmployeeIds?: string[] | null },
  ): Promise<ExecOtPendingRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const scope = options?.restrictToEmployeeIds ?? null
    if (Array.isArray(scope) && scope.length === 0) return []
    return prisma.approvalRequest.findMany({
      where: {
        kind: "OT",
        status: "PENDING",
        employee: { organizationId: orgId },
        ...(scope ? { employeeId: { in: scope } } : {}),
      },
      select: {
        employeeId: true,
      },
    })
  },

  async getStalePendingClaims(
    orgId: string,
    olderThan: Date,
    take: number,
    options?: {
      restrictToEmployeeIds?: string[] | null
      paymentTypes?: Array<"PERSONAL" | "COMPANY">
    },
  ): Promise<ExecStalePendingClaimRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const scope = options?.restrictToEmployeeIds ?? null
    if (Array.isArray(scope) && scope.length === 0) return []
    const paymentTypes = options?.paymentTypes
    if (paymentTypes && paymentTypes.length === 0) return []
    return prisma.claim.findMany({
      where: {
        organizationId: orgId,
        status: { in: ["PENDING", "SUBMITTED"] },
        submittedAt: { lt: olderThan },
        ...(scope ? { employeeId: { in: scope } } : {}),
        ...(paymentTypes && paymentTypes.length > 0
          ? { paymentType: { in: paymentTypes } }
          : {}),
      },
      orderBy: { submittedAt: "asc" },
      take,
      select: {
        id: true,
        claimNumber: true,
        title: true,
        amount: true,
        submittedAt: true,
        employee: { select: { name: true } },
      },
    })
  },

  async getOrgClaimCutoffDay(orgId: string): Promise<number | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { claimCutoffDay: true },
    })
    return org?.claimCutoffDay ?? null
  },

  async getClaimsInRunForOrg(
    orgId: string,
    monthStart: Date,
    monthEnd: Date,
    options?: {
      restrictToEmployeeIds?: string[] | null
      paymentTypes?: Array<"PERSONAL" | "COMPANY">
    },
  ): Promise<ExecRunClaimRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const scope = options?.restrictToEmployeeIds ?? null
    if (Array.isArray(scope) && scope.length === 0) return []
    const paymentTypes = options?.paymentTypes
    if (paymentTypes && paymentTypes.length === 0) return []
    return prisma.claim.findMany({
      where: {
        organizationId: orgId,
        claimRunMonth: { gte: monthStart, lte: monthEnd },
        ...(scope ? { employeeId: { in: scope } } : {}),
        ...(paymentTypes && paymentTypes.length > 0
          ? { paymentType: { in: paymentTypes } }
          : {}),
      },
      select: { amount: true, status: true },
    })
  },

  async getRejectedClaimsSinceForOrg(
    orgId: string,
    since: Date,
    options?: {
      restrictToEmployeeIds?: string[] | null
      paymentTypes?: Array<"PERSONAL" | "COMPANY">
    },
  ): Promise<ExecRejectedClaimRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const scope = options?.restrictToEmployeeIds ?? null
    if (Array.isArray(scope) && scope.length === 0) return []
    const paymentTypes = options?.paymentTypes
    if (paymentTypes && paymentTypes.length === 0) return []
    return prisma.claim.findMany({
      where: {
        organizationId: orgId,
        status: "REJECTED",
        lastReviewedAt: { gte: since },
        ...(scope ? { employeeId: { in: scope } } : {}),
        ...(paymentTypes && paymentTypes.length > 0
          ? { paymentType: { in: paymentTypes } }
          : {}),
      },
      select: { id: true, employeeId: true, lastReviewerId: true },
    })
  },

  async getChainStepsForOrg(
    orgId: string,
    options?: { restrictToEmployeeIds?: string[] | null },
  ): Promise<ExecChainStepRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const scope = options?.restrictToEmployeeIds ?? null
    if (Array.isArray(scope) && scope.length === 0) return []
    return prisma.approvalChainStep.findMany({
      where: {
        employee: { organizationId: orgId },
        ...(scope ? { employeeId: { in: scope } } : {}),
      },
      select: {
        employeeId: true,
        step: true,
        approverId: true,
        approver: { select: { id: true, name: true } },
      },
      orderBy: [{ employeeId: "asc" }, { step: "asc" }],
    })
  },
}
