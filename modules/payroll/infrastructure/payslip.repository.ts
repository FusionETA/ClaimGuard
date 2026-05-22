import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { toNumber } from "@/lib/decimal"
import type {
  PayslipData,
  PayslipEpfRatesSnapshot,
  PayslipLineItemData,
  PayslipRow,
} from "@/modules/payroll/domain/runs"

/**
 * Prisma-side repository for `Payslip` + `PayslipLineItem`. All access
 * to either table goes through this file.
 *
 * Phase 4 scope: bulk create (in one transaction), list/get for read
 * paths, delete-by-run (for re-generation), and run-level total
 * aggregation.
 */

// ─── Write inputs ────────────────────────────────────────────────────────

/**
 * Input shape for `createPayslipsForRun`. One entry per employee. The
 * snapshot fields are frozen here so later edits to the source
 * `PayrollProfile` don't rewrite historical payslips.
 */
export type CreatePayslipInput = {
  employeeProfileId: string
  payrollProfileId: string | null
  // Snapshots
  snapshotName: string
  snapshotEmployeeId: string
  snapshotPosition: string | null
  snapshotSalaryType: "MONTHLY" | "HOURLY"
  snapshotMonthlySalary: number | null
  snapshotHourlyRate: number | null
  snapshotNationality: string | null
  snapshotIsResident: boolean
  snapshotEpfRates: PayslipEpfRatesSnapshot
  // Computed
  basicPay: number
  proratedPay: number
  workedHours: number | null
  expectedHours: number | null
  proratedFactor: number
  proratedDays: number | null
  totalWorkingDays: number | null
  otNormalHours: number
  otRestHours: number
  otPublicHours: number
  otPay: number
  totalAllowances: number
  totalBenefitsInKind: number
  totalReimbursements: number
  totalDeductions: number
  epfEmployee: number
  epfEmployer: number
  socsoEmployee: number
  socsoEmployer: number
  eisEmployee: number
  eisEmployer: number
  pcb: number
  hrdf: number
  hrdfWage: number
  zakat: number
  grossPay: number
  netPay: number
  totalCostToEmployer: number
  // Line items written alongside the payslip
  lineItems: Array<{
    kind: "ALLOWANCE" | "DEDUCTION" | "REIMBURSEMENT"
    label: string
    amount: number
    category: string | null
    claimId?: string
    subjectToEpf: boolean
    subjectToSocso: boolean
    subjectToEis: boolean
    subjectToPcb: boolean
  }>
}

export const payslipRepository = {
  /**
   * Atomically delete any existing payslips on a run and write a fresh
   * batch. Used by re-generation so the run-totals stay in sync with
   * what's actually on file.
   *
   * Prisma cascades PayslipLineItem deletes via the relation.
   */
  async replacePayslipsForRun(input: {
    payrollRunId: string
    payslips: CreatePayslipInput[]
  }): Promise<number> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    return prisma.$transaction(async (tx) => {
      await tx.payslip.deleteMany({
        where: { payrollRunId: input.payrollRunId },
      })

      let created = 0
      for (const p of input.payslips) {
        await tx.payslip.create({
          data: {
            payrollRunId: input.payrollRunId,
            employeeProfileId: p.employeeProfileId,
            payrollProfileId: p.payrollProfileId,
            snapshotName: p.snapshotName,
            snapshotEmployeeId: p.snapshotEmployeeId,
            snapshotPosition: p.snapshotPosition,
            snapshotSalaryType: p.snapshotSalaryType,
            snapshotMonthlySalary: p.snapshotMonthlySalary,
            snapshotHourlyRate: p.snapshotHourlyRate,
            snapshotNationality: p.snapshotNationality,
            snapshotIsResident: p.snapshotIsResident,
            snapshotEpfRates: p.snapshotEpfRates as object,
            basicPay: p.basicPay,
            proratedPay: p.proratedPay,
            workedHours: p.workedHours,
            expectedHours: p.expectedHours,
            proratedFactor: p.proratedFactor,
            proratedDays: p.proratedDays,
            totalWorkingDays: p.totalWorkingDays,
            otNormalHours: p.otNormalHours,
            otRestHours: p.otRestHours,
            otPublicHours: p.otPublicHours,
            otPay: p.otPay,
            totalAllowances: p.totalAllowances,
            totalBenefitsInKind: p.totalBenefitsInKind,
            totalReimbursements: p.totalReimbursements,
            totalDeductions: p.totalDeductions,
            epfEmployee: p.epfEmployee,
            epfEmployer: p.epfEmployer,
            socsoEmployee: p.socsoEmployee,
            socsoEmployer: p.socsoEmployer,
            eisEmployee: p.eisEmployee,
            eisEmployer: p.eisEmployer,
            pcb: p.pcb,
            hrdf: p.hrdf,
            hrdfWage: p.hrdfWage,
            zakat: p.zakat,
            grossPay: p.grossPay,
            netPay: p.netPay,
            totalCostToEmployer: p.totalCostToEmployer,
            lineItems: {
              create: p.lineItems.map((li) => ({
                kind: li.kind,
                label: li.label,
                amount: li.amount,
                category: li.category ?? null,
                claimId: li.claimId ?? null,
                subjectToEpf: li.subjectToEpf,
                subjectToSocso: li.subjectToSocso,
                subjectToEis: li.subjectToEis,
                subjectToPcb: li.subjectToPcb,
              })),
            },
          },
        })
        created += 1
      }

      return created
    })
  },

  /**
   * Update the cached totals on a `PayrollRun` from the sum of its
   * payslips. Called immediately after generation so the run detail
   * card reflects what was just written.
   */
  async refreshRunTotals(input: { payrollRunId: string }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const [agg, hrdfCount] = await Promise.all([
      prisma.payslip.aggregate({
        where: { payrollRunId: input.payrollRunId },
        _count: { _all: true },
        _sum: {
          grossPay: true,
          netPay: true,
          epfEmployee: true,
          epfEmployer: true,
          socsoEmployee: true,
          socsoEmployer: true,
          eisEmployee: true,
          eisEmployer: true,
          pcb: true,
          hrdf: true,
          zakat: true,
          totalCostToEmployer: true,
          hrdfWage: true,
        },
      }),
      // Headcount with non-zero HRDF wage — only Malaysian citizens
      // contribute, so this differs from the total employee count.
      prisma.payslip.count({
        where: {
          payrollRunId: input.payrollRunId,
          hrdfWage: { gt: 0 },
        },
      }),
    ])

    await prisma.payrollRun.update({
      where: { id: input.payrollRunId },
      data: {
        employeeCount: agg._count._all,
        totalGross: agg._sum.grossPay ?? 0,
        totalNet: agg._sum.netPay ?? 0,
        totalEmployeeEpf: agg._sum.epfEmployee ?? 0,
        totalEmployerEpf: agg._sum.epfEmployer ?? 0,
        totalEmployeeSocso: agg._sum.socsoEmployee ?? 0,
        totalEmployerSocso: agg._sum.socsoEmployer ?? 0,
        totalEmployeeEis: agg._sum.eisEmployee ?? 0,
        totalEmployerEis: agg._sum.eisEmployer ?? 0,
        totalPcb: agg._sum.pcb ?? 0,
        totalHrdf: agg._sum.hrdf ?? 0,
        totalZakat: agg._sum.zakat ?? 0,
        totalCostToEmployer: agg._sum.totalCostToEmployer ?? 0,
        totalWagesSubjectToHrdf: agg._sum.hrdfWage ?? 0,
        employeesSubjectToHrdf: hrdfCount,
      },
    })
  },

  /**
   * Light-weight list of payslips for a single run. Used by the run
   * detail page. Does NOT include line items — fetch those via
   * `getForRunAndOrg` on the detail page.
   */
  async listForRun(payrollRunId: string): Promise<PayslipRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    // Eager-load line items so the run detail table can render the
    // earnings breakdown inline under each employee name. Payroll
    // runs are typically 10-100 employees with 3-8 line items each,
    // so this stays well under any practical query budget.
    const rows = await prisma.payslip.findMany({
      where: { payrollRunId },
      orderBy: { snapshotEmployeeId: "asc" },
      include: {
        lineItems: { orderBy: { id: "asc" } },
        _count: { select: { lineItems: true } },
      },
    })

    return rows.map((row) => ({
      ...mapPayslip(row, row.lineItems.map(mapPayslipLineItem)),
      lineItemCount: row._count.lineItems,
    }))
  },

  /**
   * Sum YTD taxable income / EPF / PCB across this employee's
   * SUBMITTED payslips in the given calendar year. Used by the PCB
   * calc to estimate annual income and find tax already withheld.
   *
   * Excludes the current run-in-progress (which is still DRAFT) so
   * the figure represents "what's already locked in". The orchestrator
   * adds the prev-employer carryover (TP3-like) on top via
   * `PayrollProfile.prevRemuneration` + `prevEpf`.
   */
  async getYtdForEmployee(input: {
    employeeProfileId: string
    year: number
    excludeRunId?: string
  }): Promise<{
    ytdTaxable: number
    ytdEpf: number
    ytdPcb: number
    /// Z in the LHDN MTD formula — accumulated zakat actually
    /// deducted from prior SUBMITTED payslips in this calendar year.
    /// Subtracted from annual tax inside `calcPcb` because zakat
    /// fully offsets MTD obligation.
    ytdZakat: number
    /// YTD employee-side SOCSO + EIS contributions. Feeds the RM 350
    /// SOCSO+EIS relief inside `calcPcb` (annualised, capped).
    ytdSocsoEis: number
    /// YTD sum of allowance line items grouped by their
    /// `PayrollAdjustmentCategory` code. Used by the next run to
    /// enforce `taxExemptLimit` caps (e.g. childcare RM3,000/year).
    /// Only ALLOWANCE-kind rows with a non-null `category` are
    /// counted. Empty record when the employee has no prior YTD or
    /// when all rows are legacy / uncategorised.
    ytdAllowanceByCategory: Record<string, number>
  }> {
    const prisma = getPrismaClient()
    if (!prisma) {
      return {
        ytdTaxable: 0,
        ytdEpf: 0,
        ytdPcb: 0,
        ytdZakat: 0,
        ytdSocsoEis: 0,
        ytdAllowanceByCategory: {},
      }
    }

    const [agg, byCategory] = await Promise.all([
      prisma.payslip.aggregate({
        where: {
          employeeProfileId: input.employeeProfileId,
          payrollRun: {
            periodYear: input.year,
            status: "SUBMITTED",
            ...(input.excludeRunId ? { id: { not: input.excludeRunId } } : {}),
          },
        },
        _sum: {
          proratedPay: true,
          totalAllowances: true,
          otPay: true,
          epfEmployee: true,
          socsoEmployee: true,
          eisEmployee: true,
          pcb: true,
          zakat: true,
        },
      }),
      prisma.payslipLineItem.groupBy({
        by: ["category"],
        where: {
          kind: "ALLOWANCE",
          category: { not: null },
          payslip: {
            employeeProfileId: input.employeeProfileId,
            payrollRun: {
              periodYear: input.year,
              status: "SUBMITTED",
              ...(input.excludeRunId
                ? { id: { not: input.excludeRunId } }
                : {}),
            },
          },
        },
        _sum: { amount: true },
      }),
    ])

    const ytdAllowanceByCategory: Record<string, number> = {}
    for (const row of byCategory) {
      if (!row.category) continue
      ytdAllowanceByCategory[row.category] = toNumber(row._sum.amount, 0)
    }

    return {
      ytdTaxable:
        toNumber(agg._sum.proratedPay, 0) +
        toNumber(agg._sum.totalAllowances, 0) +
        toNumber(agg._sum.otPay, 0),
      ytdEpf: toNumber(agg._sum.epfEmployee, 0),
      ytdPcb: toNumber(agg._sum.pcb, 0),
      ytdZakat: toNumber(agg._sum.zakat, 0),
      ytdSocsoEis:
        toNumber(agg._sum.socsoEmployee, 0) +
        toNumber(agg._sum.eisEmployee, 0),
      ytdAllowanceByCategory,
    }
  },

  /**
   * Employee-facing: list every payslip belonging to one employee
   * profile, but ONLY from SUBMITTED runs. Drafts are admin-only.
   * Includes period info from the parent run so the list page can
   * render "January 2026" without a follow-up query.
   */
  async listForEmployee(
    employeeProfileId: string,
  ): Promise<
    Array<
      PayslipRow & {
        periodYear: number
        periodMonth: number
        submittedAt: string | null
      }
    >
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.payslip.findMany({
      where: {
        employeeProfileId,
        payrollRun: { status: "SUBMITTED" },
      },
      orderBy: [
        { payrollRun: { periodYear: "desc" } },
        { payrollRun: { periodMonth: "desc" } },
      ],
      include: {
        _count: { select: { lineItems: true } },
        payrollRun: {
          select: {
            periodYear: true,
            periodMonth: true,
            submittedAt: true,
          },
        },
      },
    })

    return rows.map((row) => ({
      ...mapPayslip(row, []),
      lineItemCount: row._count.lineItems,
      periodYear: row.payrollRun.periodYear,
      periodMonth: row.payrollRun.periodMonth,
      submittedAt: row.payrollRun.submittedAt
        ? row.payrollRun.submittedAt.toISOString()
        : null,
    }))
  },

  /**
   * Employee-facing: fetch a single payslip scoped to the employee
   * who owns it and only when the run is SUBMITTED. Returns null in
   * any other case (cross-employee access, draft run, missing).
   */
  async getByIdForEmployee(input: {
    payslipId: string
    employeeProfileId: string
  }): Promise<PayslipData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.payslip.findFirst({
      where: {
        id: input.payslipId,
        employeeProfileId: input.employeeProfileId,
        payrollRun: { status: "SUBMITTED" },
      },
      include: {
        lineItems: { orderBy: { createdAt: "asc" } },
      },
    })
    if (!row) return null

    const lineItems = row.lineItems.map((li) => mapPayslipLineItem(li))
    return mapPayslip(row, lineItems)
  },

  /**
   * Fetch a single payslip with line items, scoped to an org via the
   * parent run. Returns null on cross-org access.
   */
  async getByIdForOrg(input: {
    payslipId: string
    organizationId: string
  }): Promise<PayslipData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.payslip.findFirst({
      where: {
        id: input.payslipId,
        payrollRun: { organizationId: input.organizationId },
      },
      include: {
        lineItems: { orderBy: { createdAt: "asc" } },
      },
    })
    if (!row) return null

    const lineItems = row.lineItems.map((li) => mapPayslipLineItem(li))
    return mapPayslip(row, lineItems)
  },
}

// ─── Projection helpers ──────────────────────────────────────────────────

function mapPayslip(row: any, lineItems: PayslipLineItemData[]): PayslipData {
  const snapshot = parseEpfRatesSnapshot(row.snapshotEpfRates)
  return {
    id: row.id,
    payrollRunId: row.payrollRunId,
    employeeProfileId: row.employeeProfileId,
    payrollProfileId: row.payrollProfileId ?? null,
    snapshotName: row.snapshotName,
    snapshotEmployeeId: row.snapshotEmployeeId,
    snapshotPosition: row.snapshotPosition ?? null,
    snapshotSalaryType: row.snapshotSalaryType,
    snapshotMonthlySalary:
      row.snapshotMonthlySalary == null
        ? null
        : toNumber(row.snapshotMonthlySalary, 0),
    snapshotHourlyRate:
      row.snapshotHourlyRate == null
        ? null
        : toNumber(row.snapshotHourlyRate, 0),
    snapshotNationality: row.snapshotNationality ?? null,
    snapshotIsResident: row.snapshotIsResident,
    snapshotEpfRates: snapshot,
    basicPay: toNumber(row.basicPay, 0),
    proratedPay: toNumber(row.proratedPay, 0),
    workedHours: row.workedHours == null ? null : toNumber(row.workedHours, 0),
    expectedHours:
      row.expectedHours == null ? null : toNumber(row.expectedHours, 0),
    proratedFactor: toNumber(row.proratedFactor, 1),
    proratedDays: row.proratedDays ?? null,
    totalWorkingDays: row.totalWorkingDays ?? null,
    otNormalHours: toNumber(row.otNormalHours, 0),
    otRestHours: toNumber(row.otRestHours, 0),
    otPublicHours: toNumber(row.otPublicHours, 0),
    otPay: toNumber(row.otPay, 0),
    totalAllowances: toNumber(row.totalAllowances, 0),
    // ?? 0 guards rows minted before the column was added.
    totalBenefitsInKind: toNumber(row.totalBenefitsInKind ?? 0, 0),
    totalReimbursements: toNumber(row.totalReimbursements, 0),
    totalDeductions: toNumber(row.totalDeductions, 0),
    epfEmployee: toNumber(row.epfEmployee, 0),
    epfEmployer: toNumber(row.epfEmployer, 0),
    socsoEmployee: toNumber(row.socsoEmployee, 0),
    socsoEmployer: toNumber(row.socsoEmployer, 0),
    eisEmployee: toNumber(row.eisEmployee, 0),
    eisEmployer: toNumber(row.eisEmployer, 0),
    pcb: toNumber(row.pcb, 0),
    hrdf: toNumber(row.hrdf, 0),
    zakat: toNumber(row.zakat, 0),
    hrdfWage: toNumber(row.hrdfWage, 0),
    grossPay: toNumber(row.grossPay, 0),
    netPay: toNumber(row.netPay, 0),
    totalCostToEmployer: toNumber(row.totalCostToEmployer, 0),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lineItems,
  }
}

function mapPayslipLineItem(row: any): PayslipLineItemData {
  return {
    id: row.id,
    payslipId: row.payslipId,
    kind: row.kind,
    label: row.label,
    amount: toNumber(row.amount, 0),
    category: row.category ?? null,
    claimId: row.claimId ?? null,
    subjectToEpf: row.subjectToEpf,
    subjectToSocso: row.subjectToSocso,
    subjectToEis: row.subjectToEis,
    subjectToPcb: row.subjectToPcb,
    createdAt: row.createdAt.toISOString(),
  }
}

function parseEpfRatesSnapshot(value: unknown): PayslipEpfRatesSnapshot {
  const fallback: PayslipEpfRatesSnapshot = {
    employee: 0,
    employer: 0,
    voluntaryEmployee: 0,
    voluntaryEmployer: 0,
  }
  if (!value || typeof value !== "object") return fallback
  const v = value as Record<string, unknown>
  return {
    employee: toNum(v.employee),
    employer: toNum(v.employer),
    voluntaryEmployee: toNum(v.voluntaryEmployee),
    voluntaryEmployer: toNum(v.voluntaryEmployer),
  }
}

function toNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}
