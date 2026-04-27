import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"
import type {
  AdminProfile,
  ClaimRecord,
  ClaimStatus,
  PortalUser,
} from "@/modules/claims/domain/models"

function buildInitials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

type PrismaUser = {
  id?: string
  name: string
  email: string
  role: string
  organizationId?: string | null
  organization?: {
    id: string
    name: string
    claimCutoffDay: number
  } | null
  employeeProfile: {
    employeeId: string
    project: string
    jobTitle: string
    supervisorId: string | null
    supervisor?: {
      name: string
      email: string
    } | null
    payoutMethod: string | null
    preferredCurrency: string
    xeroConnectionId?: string | null
    xeroConnection?: { tenantName: string } | null
  } | null
}

type PrismaClaim = {
  id: string
  claimNumber: string
  title: string
  description: string
  amount: { toString(): string } | number | string
  currency: string
  spentAt: Date
  submittedAt: Date
  claimRunMonth: Date | null
  status: string
  receiptUrl: string | null
  reviewNotes: string | null
  reviewer: { name: string } | null
  organization: { name: string } | null
  chartOfAccount: {
    id: string
    code: string
    name: string
    type: string | null
    status: string | null
    isSelectable: boolean
  } | null
  employee: PrismaUser
}

export type CreateClaimData = {
  claimNumber: string
  title: string
  description: string
  amount: string
  currency: string
  spentAt: Date
  receiptUrl?: string
  organizationId: string
  chartOfAccountId: string
  claimRunMonth: Date
  employeeId: string
  reviewerId: string | null
}

export type ReviewClaimData = {
  claimId: string
  status: "APPROVED" | "REJECTED"
  reviewNotes?: string
  reviewerId: string
  supervisorOnly?: boolean
}

export type ReviewClaimResult =
  | {
      ok: true
      claimId: string
      employeeEmail: string
      employeeUserId: string
      claimTitle: string
    }
  | {
      ok: false
      error: "DB_UNAVAILABLE" | "NOT_FOUND" | "NOT_ACTIONABLE"
    }

export type ClaimForXeroSync = {
  id: string
  claimNumber: string
  title: string
  description: string
  amount: number
  currency: string
  spentAt: Date
  xeroBillId: string | null
  chartOfAccount?: {
    code: string
    name: string
  } | null
  employee: {
    name: string
    email: string
  }
}

function mapChartAccount(account?: {
  id: string
  code: string
  name: string
  type: string | null
  status: string | null
  isSelectable: boolean
} | null): ChartOfAccountOption | undefined {
  if (!account) return undefined

  return {
    id: account.id,
    code: account.code,
    name: account.name,
    type: account.type ?? undefined,
    status: account.status ?? undefined,
    isSelectable: account.isSelectable,
  }
}

function mapUser(user: PrismaUser): PortalUser {
  return {
    name: user.name,
    email: user.email,
    employeeId: user.employeeProfile?.employeeId ?? "N/A",
    role: user.role as PortalUser["role"],
    organizationId: user.organizationId ?? undefined,
    organizationName: user.organization?.name ?? undefined,
    project: user.employeeProfile?.project ?? "Unknown",
    jobTitle: user.employeeProfile?.jobTitle ?? "Employee",
    initials: buildInitials(user.name),
    supervisorEmail: user.employeeProfile?.supervisor?.email ?? undefined,
    supervisorName: user.employeeProfile?.supervisor?.name ?? undefined,
    payoutMethod: user.employeeProfile?.payoutMethod ?? undefined,
    preferredCurrency: user.employeeProfile?.preferredCurrency ?? "USD",
    xeroConnectionId: user.employeeProfile?.xeroConnectionId ?? undefined,
    xeroConnectionName: user.employeeProfile?.xeroConnection?.tenantName ?? undefined,
  }
}

function mapClaim(claim: PrismaClaim): ClaimRecord {
  return {
    id: claim.id,
    claimNumber: claim.claimNumber,
    title: claim.title,
    description: claim.description,
    organizationName: claim.organization?.name ?? undefined,
    chartOfAccount: mapChartAccount(claim.chartOfAccount),
    amount: Number(claim.amount),
    currency: claim.currency,
    spentAt: claim.spentAt.toISOString(),
    submittedAt: claim.submittedAt.toISOString(),
    claimRunMonth: claim.claimRunMonth?.toISOString(),
    status: claim.status as ClaimStatus,
    receiptUrl: claim.receiptUrl ?? undefined,
    reviewNotes: claim.reviewNotes ?? undefined,
    reviewerName: claim.reviewer?.name ?? undefined,
    employee: mapUser(claim.employee),
  }
}

const claimInclude = {
  organization: true,
  chartOfAccount: true,
  employee: {
    include: {
      organization: true,
      employeeProfile: {
        include: {
          supervisor: true,
          xeroConnection: { select: { tenantName: true } },
        },
      },
    },
  },
  reviewer: true,
} as const

export const claimRepository = {
  async getEmployeeWithProfile(email: string): Promise<PortalUser | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where: { email, role: { in: ["EMPLOYEE", "SUPERVISOR"] } },
      include: {
        organization: true,
        employeeProfile: {
          include: {
            supervisor: true,
            xeroConnection: { select: { tenantName: true } },
          },
        },
      },
    })

    return row ? mapUser(row) : null
  },

  async getAdminProfile(email: string): Promise<AdminProfile | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where: { email, role: "ADMIN" },
      include: {
        organization: true,
      },
    })

    if (!row) return null

    return {
      name: row.name,
      email: row.email,
      role: "Administrator",
      initials: buildInitials(row.name),
      organizationId: row.organizationId ?? undefined,
      organizationName: row.organization?.name ?? undefined,
    }
  },

  async getClaimsByEmployee(email: string): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.claim.findMany({
      where: { employee: { email } },
      include: claimInclude,
      orderBy: { submittedAt: "desc" },
    })

    return rows.map(mapClaim)
  },

  async getClaimsForSupervisor(email: string): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const supervisor = await prisma.user.findFirst({
      where: { email, role: "SUPERVISOR" },
      select: { id: true, organizationId: true },
    })

    if (!supervisor) return []

    const rows = await prisma.claim.findMany({
      where: {
        organizationId: supervisor.organizationId ?? undefined,
        employee: {
          employeeProfile: {
            supervisorId: supervisor.id,
          },
        },
      },
      include: claimInclude,
      orderBy: { submittedAt: "desc" },
    })

    return rows.map(mapClaim)
  },

  async getClaimsForOrganization(
    organizationId: string,
    xeroConnectionId?: string
  ): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.claim.findMany({
      where: {
        organizationId,
        ...(xeroConnectionId
          ? { employee: { employeeProfile: { xeroConnectionId } } }
          : {}),
      },
      include: claimInclude,
      orderBy: { submittedAt: "desc" },
    })

    return rows.map(mapClaim)
  },

  async getFirstAdminId(organizationId?: string): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where: {
        role: "ADMIN",
        ...(organizationId ? { organizationId } : {}),
      },
      orderBy: { createdAt: "asc" },
    })
    return row?.id ?? null
  },

  async getUserId(
    email: string,
    role: "EMPLOYEE" | "SUPERVISOR" | "ADMIN"
  ): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where:
        role === "EMPLOYEE"
          ? { email, role: { in: ["EMPLOYEE", "SUPERVISOR"] } }
          : { email, role },
    })
    return row?.id ?? null
  },

  async getSupervisorIdForUser(userId: string): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.employeeProfile.findUnique({
      where: { userId },
      select: { supervisorId: true },
    })

    return row?.supervisorId ?? null
  },

  async createClaim(data: CreateClaimData): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false

    await prisma.claim.create({
      data: {
        claimNumber: data.claimNumber,
        title: data.title,
        description: data.description,
        category: "OTHER",
        organizationId: data.organizationId,
        chartOfAccountId: data.chartOfAccountId,
        amount: data.amount,
        currency: data.currency,
        spentAt: data.spentAt,
        claimRunMonth: data.claimRunMonth,
        receiptUrl: data.receiptUrl,
        employeeId: data.employeeId,
        reviewerId: data.reviewerId,
      },
    })
    return true
  },

  async reviewClaim(data: ReviewClaimData): Promise<ReviewClaimResult> {
    const prisma = getPrismaClient()
    if (!prisma) {
      return { ok: false, error: "DB_UNAVAILABLE" }
    }

    const existingClaim = await prisma.claim.findUnique({
      where: { id: data.claimId },
      select: {
        id: true,
        title: true,
        status: true,
        employeeId: true,
        employee: {
          select: {
            email: true,
            employeeProfile: {
              select: {
                supervisorId: true,
              },
            },
          },
        },
      },
    })

    if (!existingClaim) {
      return { ok: false, error: "NOT_FOUND" }
    }

    if (existingClaim.status !== "SUBMITTED" && existingClaim.status !== "PENDING") {
      return { ok: false, error: "NOT_ACTIONABLE" }
    }

    if (
      data.supervisorOnly &&
      existingClaim.employee.employeeProfile?.supervisorId !== data.reviewerId
    ) {
      return { ok: false, error: "NOT_FOUND" }
    }

    await prisma.claim.update({
      where: { id: data.claimId },
      data: {
        status: data.status,
        reviewNotes: data.reviewNotes || null,
        reviewedAt: new Date(),
        reviewerId: data.reviewerId,
      },
    })

    return {
      ok: true,
      claimId: existingClaim.id,
      employeeEmail: existingClaim.employee.email,
      employeeUserId: existingClaim.employeeId,
      claimTitle: existingClaim.title,
    }
  },

  async getClaimForXeroSync(claimId: string): Promise<ClaimForXeroSync | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const claim = await prisma.claim.findUnique({
      where: { id: claimId },
      select: {
        id: true,
        claimNumber: true,
        title: true,
        description: true,
        amount: true,
        currency: true,
        spentAt: true,
        xeroBillId: true,
        chartOfAccount: {
          select: {
            code: true,
            name: true,
          },
        },
        employee: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    })

    if (!claim) return null

    return {
      id: claim.id,
      claimNumber: claim.claimNumber,
      title: claim.title,
      description: claim.description,
      amount: Number(claim.amount),
      currency: claim.currency,
      spentAt: claim.spentAt,
      xeroBillId: claim.xeroBillId,
      chartOfAccount: claim.chartOfAccount,
      employee: claim.employee,
    }
  },

  async markClaimXeroSynced(data: {
    claimId: string
    xeroBillId: string
    xeroBillRef?: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.claim.update({
      where: { id: data.claimId },
      data: {
        xeroBillId: data.xeroBillId,
        xeroBillRef: data.xeroBillRef ?? null,
        xeroSyncStatus: "SYNCED",
        xeroSyncError: null,
        xeroSyncedAt: new Date(),
      },
    })
  },

  async markClaimXeroError(data: {
    claimId: string
    message: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) {
      throw new Error("Database is not configured.")
    }

    await prisma.claim.update({
      where: { id: data.claimId },
      data: {
        xeroSyncStatus: "ERROR",
        xeroSyncError: data.message.slice(0, 5000),
      },
    })
  },
}
