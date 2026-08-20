import "server-only"

import { toNumber } from "@/lib/decimal"
import { getPrismaClient } from "@/lib/prisma"
import type { SalaryType } from "@/modules/payroll/domain/models"
import type {
  SalaryChangeData,
  SalaryChangeReason,
} from "@/modules/payroll/domain/salary-change"

/**
 * Repository for `SalaryChange` rows. Each row is an immutable audit
 * entry — there's no update/delete API on purpose. If a change was
 * recorded in error, the admin should record a NEW change that
 * reverses it (with reason: OTHER and notes explaining), not edit
 * history.
 */
export const salaryChangeRepository = {
  /**
   * Record a new salary change. Caller (service layer) is responsible
   * for snapshotting the previous values BEFORE updating the
   * `PayrollProfile` row.
   */
  async create(input: {
    employeeProfileId: string
    effectiveDate: string // ISO yyyy-mm-dd
    previousSalaryType: SalaryType
    previousMonthlySalary: number | null
    previousHourlyRate: number | null
    newSalaryType: SalaryType
    newMonthlySalary: number | null
    newHourlyRate: number | null
    reason: SalaryChangeReason
    notes: string | null
    changedByUserId: string | null
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    await (prisma as any).salaryChange.create({
      data: {
        employeeProfileId: input.employeeProfileId,
        effectiveDate: new Date(input.effectiveDate),
        previousSalaryType: input.previousSalaryType,
        previousMonthlySalary: input.previousMonthlySalary,
        previousHourlyRate: input.previousHourlyRate,
        newSalaryType: input.newSalaryType,
        newMonthlySalary: input.newMonthlySalary,
        newHourlyRate: input.newHourlyRate,
        reason: input.reason,
        notes: input.notes,
        changedByUserId: input.changedByUserId,
      },
    })
  },

  /**
   * List all salary changes for an employee, most recent effective
   * date first. Used by the "Salary history" card on the employee
   * detail page.
   */
  async listForEmployee(
    employeeProfileId: string,
  ): Promise<SalaryChangeData[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await (prisma as any).salaryChange.findMany({
      where: { employeeProfileId },
      include: {
        changedByUser: { select: { name: true } },
      },
      orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
    })

    return rows.map(mapSalaryChange)
  },

  /**
   * Find every salary change whose `effectiveDate` falls inside a
   * date range, scoped to an organisation (defence-in-depth — never
   * leak another org's salary moves).
   *
   * Used by the smart-hint service to surface mid-cycle changes on
   * a payroll run: passing `(periodStart, periodEnd)` returns
   * changes that landed during that run's period.
   */
  async findInDateRangeForOrg(input: {
    organizationId: string
    fromDate: string // inclusive ISO yyyy-mm-dd
    toDate: string // inclusive ISO yyyy-mm-dd
  }): Promise<SalaryChangeData[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const from = new Date(input.fromDate)
    const to = new Date(input.toDate)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return []

    const rows = await (prisma as any).salaryChange.findMany({
      where: {
        effectiveDate: { gte: from, lte: to },
        employeeProfile: {
          organizationId: input.organizationId,
        },
      },
      include: {
        changedByUser: { select: { name: true } },
      },
      orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }],
    })
    return rows.map(mapSalaryChange)
  },
}

function mapSalaryChange(row: {
  id: string
  employeeProfileId: string
  effectiveDate: Date
  previousSalaryType: SalaryType
  previousMonthlySalary: unknown
  previousHourlyRate: unknown
  newSalaryType: SalaryType
  newMonthlySalary: unknown
  newHourlyRate: unknown
  reason: SalaryChangeReason
  notes: string | null
  changedByUserId: string | null
  changedByUser: { name: string } | null
  createdAt: Date
}): SalaryChangeData {
  return {
    id: row.id,
    employeeProfileId: row.employeeProfileId,
    effectiveDate: row.effectiveDate.toISOString().slice(0, 10),
    previousSalaryType: row.previousSalaryType,
    previousMonthlySalary:
      row.previousMonthlySalary === null
        ? null
        : toNumber(row.previousMonthlySalary, 0),
    previousHourlyRate:
      row.previousHourlyRate === null
        ? null
        : toNumber(row.previousHourlyRate, 0),
    newSalaryType: row.newSalaryType,
    newMonthlySalary:
      row.newMonthlySalary === null ? null : toNumber(row.newMonthlySalary, 0),
    newHourlyRate:
      row.newHourlyRate === null ? null : toNumber(row.newHourlyRate, 0),
    reason: row.reason,
    notes: row.notes,
    changedByUserId: row.changedByUserId,
    changedByName: row.changedByUser?.name ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}
