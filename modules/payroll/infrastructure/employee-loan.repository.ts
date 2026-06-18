import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { toNumber } from "@/lib/decimal"
import {
  buildEqualSchedule,
  type EmployeeLoanData,
  type LoanRepaymentMode,
  type LoanStatus,
} from "@/modules/payroll/domain/loans"

type LoanRow = {
  id: string
  organizationId: string
  employeeProfileId: string
  principalAmount: unknown
  mode: string
  installmentAmount: unknown
  startYear: number
  startMonth: number
  installmentCount: number
  schedule: unknown
  status: string
  notes: string | null
  createdAt: Date
  employeeProfile?: {
    employeeId: string
    user: { name: string | null } | null
  } | null
}

/** Parse the stored JSON schedule into a number[]; build an equal split
 *  as a fallback for legacy rows that predate the column. */
function parseSchedule(
  raw: unknown,
  principal: number,
  installmentAmount: number,
  installmentCount: number,
): number[] {
  if (
    Array.isArray(raw) &&
    raw.length === installmentCount &&
    raw.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return raw as number[]
  }
  return buildEqualSchedule(principal, installmentAmount, installmentCount)
}

function toData(row: LoanRow): EmployeeLoanData {
  const principalAmount = toNumber(row.principalAmount, 0)
  const installmentAmount = toNumber(row.installmentAmount, 0)
  return {
    id: row.id,
    employeeProfileId: row.employeeProfileId,
    employeeName: row.employeeProfile?.user?.name ?? undefined,
    employeeCode: row.employeeProfile?.employeeId ?? undefined,
    principalAmount,
    mode: row.mode as LoanRepaymentMode,
    installmentAmount,
    startYear: row.startYear,
    startMonth: row.startMonth,
    installmentCount: row.installmentCount,
    schedule: parseSchedule(
      row.schedule,
      principalAmount,
      installmentAmount,
      row.installmentCount,
    ),
    status: row.status as LoanStatus,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  }
}

const withEmployee = {
  employeeProfile: {
    select: { employeeId: true, user: { select: { name: true } } },
  },
} as const

/**
 * Persistence for `EmployeeLoan`. One row per loan; repayment progress
 * is derived in the service from SUBMITTED runs, not stored here.
 */
export const employeeLoanRepository = {
  async listForOrganization(
    organizationId: string,
    options?: { policyIdScope?: string[] | null },
  ): Promise<EmployeeLoanData[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []
    const rows = await prisma.employeeLoan.findMany({
      where: {
        organizationId,
        ...(policyIdScope && policyIdScope.length > 0
          ? {
              employeeProfile: { policyId: { in: policyIdScope } },
            }
          : {}),
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: withEmployee,
    })
    return rows.map(toData)
  },

  /** Active loans only — used by run generation to apply installments. */
  async listActiveForOrganization(
    organizationId: string,
  ): Promise<EmployeeLoanData[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.employeeLoan.findMany({
      where: { organizationId, status: "ACTIVE" },
      include: withEmployee,
    })
    return rows.map(toData)
  },

  async getByIdForOrg(input: {
    id: string
    organizationId: string
  }): Promise<EmployeeLoanData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.employeeLoan.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      include: withEmployee,
    })
    return row ? toData(row) : null
  },

  async create(input: {
    organizationId: string
    employeeProfileId: string
    principalAmount: number
    mode: LoanRepaymentMode
    installmentAmount: number
    startYear: number
    startMonth: number
    installmentCount: number
    schedule: number[]
    notes: string | null
  }): Promise<EmployeeLoanData> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const row = await prisma.employeeLoan.create({
      data: {
        organizationId: input.organizationId,
        employeeProfileId: input.employeeProfileId,
        principalAmount: input.principalAmount,
        mode: input.mode,
        installmentAmount: input.installmentAmount,
        startYear: input.startYear,
        startMonth: input.startMonth,
        installmentCount: input.installmentCount,
        schedule: input.schedule,
        notes: input.notes,
      },
      include: withEmployee,
    })
    return toData(row)
  },

  /** Replace the editable terms of a loan (scoped to org). */
  async update(input: {
    id: string
    organizationId: string
    principalAmount: number
    mode: LoanRepaymentMode
    installmentAmount: number
    startYear: number
    startMonth: number
    installmentCount: number
    schedule: number[]
    notes: string | null
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return
    await prisma.employeeLoan.updateMany({
      where: { id: input.id, organizationId: input.organizationId },
      data: {
        principalAmount: input.principalAmount,
        mode: input.mode,
        installmentAmount: input.installmentAmount,
        startYear: input.startYear,
        startMonth: input.startMonth,
        installmentCount: input.installmentCount,
        schedule: input.schedule,
        notes: input.notes,
      },
    })
  },

  async setStatus(input: {
    id: string
    organizationId: string
    status: LoanStatus
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return
    await prisma.employeeLoan.updateMany({
      where: { id: input.id, organizationId: input.organizationId },
      data: { status: input.status },
    })
  },
}
