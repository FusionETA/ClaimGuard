import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import type {
  AdminProfile,
  ClaimCategory,
  ClaimRecord,
  ClaimStatus,
  OrganizationMember,
  PortalUser,
} from "@/modules/claims/domain/models"

// ---------------------------------------------------------------------------
// Internal Prisma shape helpers
// ---------------------------------------------------------------------------

function buildInitials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

type PrismaUser = {
  id?: string
  name: string
  email: string
  role: string
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
  } | null
}

function mapUser(user: PrismaUser): PortalUser {
  return {
    name: user.name,
    email: user.email,
    employeeId: user.employeeProfile?.employeeId ?? "N/A",
    role: user.role as PortalUser["role"],
    project: user.employeeProfile?.project ?? "Unknown",
    jobTitle: user.employeeProfile?.jobTitle ?? "Employee",
    initials: buildInitials(user.name),
    supervisorEmail: user.employeeProfile?.supervisor?.email ?? undefined,
    supervisorName: user.employeeProfile?.supervisor?.name ?? undefined,
    payoutMethod: user.employeeProfile?.payoutMethod ?? undefined,
    preferredCurrency: user.employeeProfile?.preferredCurrency ?? "USD",
  }
}

type PrismaClaim = {
  id: string
  claimNumber: string
  title: string
  description: string
  category: string
  amount: { toString(): string } | number | string
  currency: string
  spentAt: Date
  submittedAt: Date
  status: string
  receiptUrl: string | null
  reviewNotes: string | null
  reviewer: { name: string } | null
  employee: PrismaUser
}

function mapClaim(claim: PrismaClaim): ClaimRecord {
  return {
    id: claim.id,
    claimNumber: claim.claimNumber,
    title: claim.title,
    description: claim.description,
    category: claim.category as ClaimCategory,
    amount: Number(claim.amount),
    currency: claim.currency,
    spentAt: claim.spentAt.toISOString(),
    submittedAt: claim.submittedAt.toISOString(),
    status: claim.status as ClaimStatus,
    receiptUrl: claim.receiptUrl ?? undefined,
    reviewNotes: claim.reviewNotes ?? undefined,
    reviewerName: claim.reviewer?.name ?? undefined,
    employee: mapUser(claim.employee),
  }
}

const claimInclude = {
  employee: {
    include: {
      employeeProfile: {
        include: {
          supervisor: true,
        },
      },
    },
  },
  reviewer: true,
} as const

// ---------------------------------------------------------------------------
// Repository — all Prisma queries live here
// ---------------------------------------------------------------------------

export type CreateClaimData = {
  claimNumber: string
  title: string
  description: string
  category: ClaimCategory
  amount: string
  currency: string
  spentAt: Date
  receiptUrl?: string
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
      employeeEmail: string
    }
  | {
      ok: false
      error: "DB_UNAVAILABLE" | "NOT_FOUND" | "NOT_ACTIONABLE"
    }

export const claimRepository = {
  /** Returns the employee's profile row, or null if not found. */
  async getEmployeeWithProfile(email: string): Promise<PortalUser | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where: { email, role: { in: ["EMPLOYEE", "SUPERVISOR"] } },
      include: {
        employeeProfile: {
          include: {
            supervisor: true,
          },
        },
      },
    })

    return row ? mapUser(row) : null
  },

  /** Returns the admin's profile row, or null if not found. */
  async getAdminProfile(email: string): Promise<AdminProfile | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({
      where: { email, role: "ADMIN" },
    })

    if (!row) return null

    return {
      name: row.name,
      email: row.email,
      role: "Administrator",
      initials: buildInitials(row.name),
    }
  },

  /** Returns all claims belonging to the given employee email, newest first. */
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

  /** Returns claims submitted by employees who report to the supervisor. */
  async getClaimsForSupervisor(email: string): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const supervisor = await prisma.user.findFirst({
      where: { email, role: "SUPERVISOR" },
      select: { id: true },
    })

    if (!supervisor) return []

    const rows = await prisma.claim.findMany({
      where: {
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

  /** Returns every claim in the system, newest first. */
  async getAllClaims(): Promise<ClaimRecord[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.claim.findMany({
      include: claimInclude,
      orderBy: { submittedAt: "desc" },
    })

    return rows.map(mapClaim)
  },

  /** Finds the first admin user id (used as default reviewer). */
  async getFirstAdminId(): Promise<string | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.user.findFirst({ where: { role: "ADMIN" } })
    return row?.id ?? null
  },

  /** Finds a user's database id by email + role. */
  async getUserId(email: string, role: "EMPLOYEE" | "SUPERVISOR" | "ADMIN"): Promise<string | null> {
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

  /** Returns employees and supervisors for hierarchy management. */
  async getOrganizationMembers(): Promise<OrganizationMember[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.user.findMany({
      where: { role: { in: ["EMPLOYEE", "SUPERVISOR"] } },
      include: {
        employeeProfile: {
          include: {
            supervisor: true,
          },
        },
      },
      orderBy: { name: "asc" },
    })

    return rows.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as OrganizationMember["role"],
      employeeId: user.employeeProfile?.employeeId ?? "N/A",
      project: user.employeeProfile?.project ?? "Unknown",
      jobTitle: user.employeeProfile?.jobTitle ?? "Employee",
      supervisorId: user.employeeProfile?.supervisorId ?? undefined,
      supervisorName: user.employeeProfile?.supervisor?.name ?? undefined,
    }))
  },

  /** Updates a user's employee role and profile hierarchy fields. */
  async updateOrganizationMember(data: {
    userId: string
    role: "EMPLOYEE" | "SUPERVISOR"
    project: string
    jobTitle: string
    supervisorId?: string
  }): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false

    await prisma.$transaction([
      prisma.user.update({
        where: { id: data.userId },
        data: { role: data.role },
      }),
      prisma.employeeProfile.update({
        where: { userId: data.userId },
        data: {
          project: data.project,
          jobTitle: data.jobTitle,
          supervisorId: data.supervisorId || null,
        },
      }),
    ])

    return true
  },

  /** Inserts a new claim row. Returns true on success. */
  async createClaim(data: CreateClaimData): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false

    await prisma.claim.create({ data })
    return true
  },

  /** Updates a pending/submitted claim with an admin review decision. */
  async reviewClaim(data: ReviewClaimData): Promise<ReviewClaimResult> {
    const prisma = getPrismaClient()
    if (!prisma) {
      return { ok: false, error: "DB_UNAVAILABLE" }
    }

    const existingClaim = await prisma.claim.findUnique({
      where: { id: data.claimId },
      select: {
        id: true,
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

    if (data.supervisorOnly && existingClaim.employee.employeeProfile?.supervisorId !== data.reviewerId) {
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
      employeeEmail: existingClaim.employee.email,
    }
  },
}
