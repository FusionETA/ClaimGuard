import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import type { EmployeePolicy } from "@/modules/policy/domain/models"
import type {
  EmployeePayoutMethod,
  OtPayoutMethod,
} from "@/modules/organization/domain/models"

type PolicyRow = {
  id: string
  organizationId: string
  name: string
  description: string | null
  isDefault: boolean
  archivedAt: Date | null
  canAccessAttendance: boolean
  canAccessClaims: boolean
  canAccessLeave: boolean
  salaryType: EmployeePayoutMethod
  otEnabled: boolean
  otMethod: OtPayoutMethod
  requireGeofence: boolean
  requireSelfie: boolean
}

function toPolicy(row: PolicyRow, employeeCount?: number): EmployeePolicy {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description ?? undefined,
    isDefault: row.isDefault,
    archived: row.archivedAt !== null,
    canAccessAttendance: row.canAccessAttendance,
    canAccessClaims: row.canAccessClaims,
    canAccessLeave: row.canAccessLeave,
    salaryType: row.salaryType,
    otEnabled: row.otEnabled,
    otMethod: row.otMethod,
    requireGeofence: row.requireGeofence,
    requireSelfie: row.requireSelfie,
    employeeCount,
  }
}

export type PolicyCreateInput = {
  organizationId: string
  name: string
  description?: string
  canAccessAttendance: boolean
  canAccessClaims: boolean
  canAccessLeave: boolean
  salaryType: EmployeePayoutMethod
  otEnabled: boolean
  otMethod: OtPayoutMethod
  requireGeofence: boolean
  requireSelfie: boolean
  isDefault?: boolean
}

export type PolicyUpdateInput = {
  id: string
  organizationId: string
  name?: string
  description?: string | null
  canAccessAttendance?: boolean
  canAccessClaims?: boolean
  canAccessLeave?: boolean
  salaryType?: EmployeePayoutMethod
  otEnabled?: boolean
  otMethod?: OtPayoutMethod
  requireGeofence?: boolean
  requireSelfie?: boolean
}

export const policyRepository = {
  async listForOrganization(organizationId: string): Promise<EmployeePolicy[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.employeePolicy.findMany({
      where: { organizationId },
      orderBy: [{ archivedAt: "asc" }, { isDefault: "desc" }, { name: "asc" }],
      include: { _count: { select: { employees: true } } },
    })
    return rows.map((r) =>
      toPolicy(r as unknown as PolicyRow, (r as { _count: { employees: number } })._count.employees),
    )
  },

  async findById(
    id: string,
    organizationId: string,
  ): Promise<EmployeePolicy | null> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const row = await prisma.employeePolicy.findFirst({
      where: { id, organizationId },
    })
    return row ? toPolicy(row as unknown as PolicyRow) : null
  },

  async findDefault(organizationId: string): Promise<EmployeePolicy | null> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const row = await prisma.employeePolicy.findFirst({
      where: { organizationId, isDefault: true, archivedAt: null },
    })
    return row ? toPolicy(row as unknown as PolicyRow) : null
  },

  async create(input: PolicyCreateInput): Promise<EmployeePolicy> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    return prisma.$transaction(async (tx) => {
      // First policy in an org is automatically the default.
      const existingCount = await tx.employeePolicy.count({
        where: { organizationId: input.organizationId },
      })
      const isDefault = input.isDefault ?? existingCount === 0

      if (isDefault) {
        await tx.employeePolicy.updateMany({
          where: { organizationId: input.organizationId, isDefault: true },
          data: { isDefault: false },
        })
      }

      const row = await tx.employeePolicy.create({
        data: {
          organizationId: input.organizationId,
          name: input.name,
          description: input.description ?? null,
          canAccessAttendance: input.canAccessAttendance,
          canAccessClaims: input.canAccessClaims,
          canAccessLeave: input.canAccessLeave,
          salaryType: input.salaryType,
          otEnabled: input.otEnabled,
          otMethod: input.otMethod,
          requireGeofence: input.requireGeofence,
          requireSelfie: input.requireSelfie,
          isDefault,
        },
      })
      return toPolicy(row as unknown as PolicyRow)
    })
  },

  async update(input: PolicyUpdateInput): Promise<EmployeePolicy> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    return prisma.$transaction(async (tx) => {
      const policy = await tx.employeePolicy.findFirst({
        where: { id: input.id, organizationId: input.organizationId },
      })
      if (!policy) {
        throw new Error("Policy not found")
      }
      const updated = await tx.employeePolicy.update({
        where: { id: input.id },
        data: {
          name: input.name ?? undefined,
          description:
            input.description === undefined ? undefined : input.description,
          canAccessAttendance: input.canAccessAttendance ?? undefined,
          canAccessClaims: input.canAccessClaims ?? undefined,
          canAccessLeave: input.canAccessLeave ?? undefined,
          salaryType: input.salaryType ?? undefined,
          otEnabled: input.otEnabled ?? undefined,
          otMethod: input.otMethod ?? undefined,
          requireGeofence: input.requireGeofence ?? undefined,
          requireSelfie: input.requireSelfie ?? undefined,
        },
      })
      return toPolicy(updated as unknown as PolicyRow)
    })
  },

  async setDefault(id: string, organizationId: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.$transaction(async (tx) => {
      const policy = await tx.employeePolicy.findFirst({
        where: { id, organizationId, archivedAt: null },
      })
      if (!policy) {
        throw new Error("Active policy not found")
      }
      await tx.employeePolicy.updateMany({
        where: { organizationId, isDefault: true },
        data: { isDefault: false },
      })
      await tx.employeePolicy.update({
        where: { id },
        data: { isDefault: true },
      })
    })
  },

  async archive(id: string, organizationId: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.$transaction(async (tx) => {
      const policy = await tx.employeePolicy.findFirst({
        where: { id, organizationId },
      })
      if (!policy) {
        throw new Error("Policy not found")
      }
      const assigned = await tx.employeeProfile.count({
        where: { policyId: id },
      })
      if (assigned > 0) {
        throw new Error(
          `Cannot archive: ${assigned} employee${assigned === 1 ? " is" : "s are"} still assigned to this policy. Reassign them first.`,
        )
      }
      if (policy.isDefault) {
        throw new Error(
          "Cannot archive the default policy. Set another policy as default first.",
        )
      }
      await tx.employeePolicy.update({
        where: { id },
        data: { archivedAt: new Date(), isDefault: false },
      })
    })
  },

  async findForUserId(userId: string): Promise<EmployeePolicy | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.employeeProfile.findUnique({
      where: { userId },
      select: { policy: true },
    })
    if (!row?.policy) return null
    return toPolicy(row.policy as unknown as PolicyRow)
  },
}
