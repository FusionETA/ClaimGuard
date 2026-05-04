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
  employee: { employeeProfile: { project: string } | null } | null
}

export type ExecAttendanceRecordRow = {
  status: string
  project: string | null
  employee: { employeeProfile: { project: string } | null } | null
}

export type ExecOtReviewedRow = {
  submittedAt: Date
  reviewedAt: Date | null
  reviewerId: string | null
  reviewer: { name: string } | null
}

export type ExecOtPendingRow = {
  employee: {
    employeeProfile: {
      supervisorId: string | null
      supervisor: { id: string; name: string } | null
    } | null
  } | null
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
  reviewerId: string | null
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
  ): Promise<ExecMonthClaimRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    return prisma.claim.findMany({
      where: {
        organizationId: orgId,
        submittedAt: { gte: monthStart, lte: monthEnd },
        status: { not: "REJECTED" },
      },
      select: {
        amount: true,
        employee: {
          select: { employeeProfile: { select: { project: true } } },
        },
      },
    })
  },

  async getAttendanceRecordsForOrg(
    orgId: string,
    from: Date,
    to: Date,
  ): Promise<ExecAttendanceRecordRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    return prisma.attendanceRecord.findMany({
      where: {
        date: { gte: from, lte: to },
        employee: { organizationId: orgId },
      },
      select: {
        status: true,
        project: true,
        employee: {
          select: { employeeProfile: { select: { project: true } } },
        },
      },
    })
  },

  async getReviewedOtApprovalsForOrg(
    orgId: string,
    since: Date,
  ): Promise<ExecOtReviewedRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    return prisma.approvalRequest.findMany({
      where: {
        kind: "OT",
        reviewerId: { not: null },
        reviewedAt: { not: null, gte: since },
        employee: { organizationId: orgId },
      },
      select: {
        submittedAt: true,
        reviewedAt: true,
        reviewerId: true,
        reviewer: { select: { name: true } },
      },
    })
  },

  async getPendingOtApprovalsForOrg(orgId: string): Promise<ExecOtPendingRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    return prisma.approvalRequest.findMany({
      where: {
        kind: "OT",
        status: "PENDING",
        employee: { organizationId: orgId },
      },
      select: {
        employee: {
          select: {
            employeeProfile: {
              select: {
                supervisorId: true,
                supervisor: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    })
  },

  async getStalePendingClaims(
    orgId: string,
    olderThan: Date,
    take: number,
  ): Promise<ExecStalePendingClaimRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    return prisma.claim.findMany({
      where: {
        organizationId: orgId,
        status: { in: ["PENDING", "SUBMITTED"] },
        submittedAt: { lt: olderThan },
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
  ): Promise<ExecRunClaimRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    return prisma.claim.findMany({
      where: {
        organizationId: orgId,
        claimRunMonth: { gte: monthStart, lte: monthEnd },
      },
      select: { amount: true, status: true },
    })
  },

  async getRejectedClaimsSinceForOrg(
    orgId: string,
    since: Date,
  ): Promise<ExecRejectedClaimRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    return prisma.claim.findMany({
      where: {
        organizationId: orgId,
        status: "REJECTED",
        reviewedAt: { gte: since },
      },
      select: { id: true, employeeId: true, reviewerId: true },
    })
  },

  async getChainStepsForOrg(orgId: string): Promise<ExecChainStepRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    return prisma.approvalChainStep.findMany({
      where: { employee: { organizationId: orgId } },
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
