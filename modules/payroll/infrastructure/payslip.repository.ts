import "server-only"

import { Prisma } from "@/generated/prisma/client"
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
  unpaidLeaveDays: number | null
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
  /// SKBBK (Skim LINDUNG 24 Jam) — employee-only. 0 before Jun 2026.
  skbbkEmployee: number
  /// Capped wage used for the SKBBK lookup. Same value as the SOCSO
  /// wage in current code; persisted separately for forward-compat.
  skbbkWage: number
  /// Snapshot of the employee's SKBBK opt-in at time of run — frozen
  /// so a re-edit of an existing submitted run reads this instead of
  /// the live profile toggle, preventing already-remitted SKBBK
  /// contributions from silently disappearing when admin re-opens a
  /// run for an unrelated adjustment.
  contributeToSkbbk: boolean
  pcb: number
  /// CP38 arrears (LHDN court order) — kept separate from `pcb` per
  /// LHDN MTD Spec 2026 page 14. Remitted in the dedicated CP38 field
  /// of CP39. 0 when no CP38 line item exists.
  cp38: number
  /// Additional PCB (Employment Income) — manual top-up folded into the
  /// CP39 standard PCB field (no dedicated column). Kept separate from
  /// `pcb` per LHDN MTD Spec 2026 page 14. 0 when no line item exists.
  voluntaryPcb: number
  /// LHDN-style PCB formula breakdown. JSON shape matches
  /// `CalcPcbBreakdown` in `modules/payroll/domain/pcb.ts`. Snapshotted
  /// so the Detailed Calculations PDF can show the exact formula that
  /// produced this row's `pcb` value. Optional for backwards compat —
  /// payslips generated before this column existed have null.
  pcbCalculation: unknown
  hrdf: number
  hrdfWage: number
  zakat: number
  grossPay: number
  netPay: number
  netShortfall: number
  totalCostToEmployer: number
  // Line items written alongside the payslip
  lineItems: Array<{
    kind: "ALLOWANCE" | "DEDUCTION" | "REIMBURSEMENT"
    label: string
    amount: number
    /// PCB-taxable portion of `amount` (see PayslipLineItemData). Null
    /// when no `taxExemptLimit` clamp was applied — the write path
    /// falls back to `amount` in the DB column.
    pcbTaxableAmount: number | null
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
  /**
   * Add ONE payslip to a run without touching the others. Used by the
   * YTD import service: the run is shared across all employees for a
   * given period, so we append payslips as we walk rows.
   *
   * Idempotent on (run, employee) — the @@unique([payrollRunId,
   * employeeProfileId]) constraint guarantees at most one payslip per
   * employee per run. We catch the dup-key error and return
   * `{ created: false }` so the caller can surface it as a skip in
   * the import summary instead of treating it as a hard error.
   */
  async addImportedPayslip(input: {
    payrollRunId: string
    payslip: CreatePayslipInput
  }): Promise<{ created: boolean }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const p = input.payslip
    try {
      await prisma.payslip.create({
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
          unpaidLeaveDays: p.unpaidLeaveDays,
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
          skbbkEmployee: p.skbbkEmployee,
          skbbkWage: p.skbbkWage,
          contributeToSkbbk: p.contributeToSkbbk,
          pcb: p.pcb,
          cp38: p.cp38,
          voluntaryPcb: p.voluntaryPcb,
          pcbCalculation: (p.pcbCalculation ?? null) as Prisma.InputJsonValue,
          hrdf: p.hrdf,
          hrdfWage: p.hrdfWage,
          zakat: p.zakat,
          grossPay: p.grossPay,
          netPay: p.netPay,
          netShortfall: p.netShortfall,
          totalCostToEmployer: p.totalCostToEmployer,
          // Nested write so each non-zero adjustment column from the
          // YTD import XLSX (bonus / commission / service charge /
          // travel-parking-phone-other allowance / unpaid leave / net
          // deduction) materialises as a PayslipLineItem the UI can
          // render in the breakdown. Without these, an imported
          // payslip showed only the gross/net totals and admins
          // couldn't see WHICH columns drove the numbers.
          ...(p.lineItems.length > 0
            ? {
                lineItems: {
                  create: p.lineItems.map((li) => ({
                    kind: li.kind,
                    label: li.label,
                    amount: li.amount,
                    category: li.category,
                    claimId: li.claimId,
                    subjectToEpf: li.subjectToEpf,
                    subjectToSocso: li.subjectToSocso,
                    subjectToEis: li.subjectToEis,
                    subjectToPcb: li.subjectToPcb,
                    pcbTaxableAmount: li.pcbTaxableAmount ?? null,
                  })),
                },
              }
            : {}),
        },
      })
      return { created: true }
    } catch (err) {
      // Prisma surfaces unique-constraint violations as P2002.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return { created: false }
      }
      throw err
    }
  },

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
            unpaidLeaveDays: p.unpaidLeaveDays,
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
            skbbkEmployee: p.skbbkEmployee,
            skbbkWage: p.skbbkWage,
            contributeToSkbbk: p.contributeToSkbbk,
            pcb: p.pcb,
            // CP38 arrears + Additional PCB (voluntaryPcb). Both were
            // computed by calc.ts and MUST be persisted on the main run
            // path too (not just the YTD-import path) — otherwise a
            // court-ordered CP38 or an admin-entered Additional PCB never
            // reaches the payslip column, the CP39 file, or the PDF.
            cp38: p.cp38,
            voluntaryPcb: p.voluntaryPcb,
            // Cast through Prisma's JSON-input shape — `pcbCalculation`
            // is `unknown` at this layer so the calc.ts type doesn't
            // need to escape the domain into the repo.
            pcbCalculation: (p.pcbCalculation ?? null) as Prisma.InputJsonValue,
            hrdf: p.hrdf,
            hrdfWage: p.hrdfWage,
            zakat: p.zakat,
            grossPay: p.grossPay,
            netPay: p.netPay,
            netShortfall: p.netShortfall,
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
                pcbTaxableAmount: li.pcbTaxableAmount ?? null,
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
   * Read the SKBBK opt-in snapshot for every existing payslip on a
   * run, keyed by employeeProfileId. Called by the run service before
   * a recompute so we can preserve the toggle decision that was made
   * when the run was first written — see the freeze semantics in
   * `Payslip.contributeToSkbbk`. Returns an empty map for fresh runs
   * (no prior payslips) → recompute falls back to the live profile
   * toggle, which is the intended "fresh calc" behaviour.
   */
  async getSkbbkSnapshotsForRun(
    payrollRunId: string,
  ): Promise<Map<string, boolean>> {
    const prisma = getPrismaClient()
    if (!prisma) return new Map()
    const rows = await prisma.payslip.findMany({
      where: { payrollRunId },
      select: { employeeProfileId: true, contributeToSkbbk: true },
    })
    return new Map(rows.map((r) => [r.employeeProfileId, r.contributeToSkbbk]))
  },

  /**
   * Light-weight list of payslips for a single run. Used by the run
   * detail page. Does NOT include line items — fetch those via
   * `getForRunAndOrg` on the detail page.
   */
  async listForRun(
    payrollRunId: string,
    options?: { policyIdScope?: string[] | null },
  ): Promise<PayslipRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []

    // Eager-load line items so the run detail table can render the
    // earnings breakdown inline under each employee name. Payroll
    // runs are typically 10-100 employees with 3-8 line items each,
    // so this stays well under any practical query budget.
    const rows = await prisma.payslip.findMany({
      where: {
        payrollRunId,
        ...(policyIdScope && policyIdScope.length > 0
          ? {
              employeeProfile: {
                policyId: { in: policyIdScope },
              },
            }
          : {}),
      },
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
    /// YTD employee-side SOCSO + EIS + SKBBK contributions. Feeds the
    /// RM 350 PERKESO relief inside `calcPcb` (annualised, capped).
    /// SKBBK joins the same bucket per Payroll Panda 2026 parity.
    ytdSocsoEis: number
    /// YTD sum of allowance line items grouped by their
    /// `PayrollAdjustmentCategory` code. Used by the next run to
    /// enforce `taxExemptLimit` caps (e.g. childcare RM3,000/year).
    /// Only ALLOWANCE-kind rows with a non-null `category` are
    /// counted. Empty record when the employee has no prior YTD or
    /// when all rows are legacy / uncategorised. Also used by the calc
    /// engine to enforce per-item LHDN TP1 caps against prior TP1
    /// deductions (life insurance, medical insurance, PRS, etc.).
    ytdAllowanceByCategory: Record<string, number>
    /// YTD TP1 allowable-deduction total from prior SUBMITTED payslips
    /// this calendar year (sum of DEDUCTION-kind line items where the
    /// meta's `feedsLp1Relief` was true). Feeds ∑LP in the PCB
    /// formula (LHDN MTD Spec 2026 page 10) so the next run's PCB
    /// correctly reflects the accumulated TP1 relief.
    ytdAllowableDeductions: number
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
        ytdAllowableDeductions: 0,
      }
    }

    const submittedPayslipFilter = {
      employeeProfileId: input.employeeProfileId,
      payrollRun: {
        periodYear: input.year,
        status: "SUBMITTED" as const,
        ...(input.excludeRunId ? { id: { not: input.excludeRunId } } : {}),
      },
    }

    // TP1 categories whose YTD sum feeds ∑LP in next month's PCB
    // calc. Hardcoded list (matches meta.feedsLp1Relief entries in
    // domain/models.ts) rather than querying by flag because the
    // PayslipLineItem row doesn't persist meta flags — it only stores
    // `category` and `kind`. Keep this list in sync when new TP1
    // sub-categories are added.
    const tp1Categories = [
      "deduct_tp1",
      "deduct_tp1_life_insurance",
      "deduct_tp1_medical_insurance",
      "deduct_tp1_prs",
      "deduct_tp1_serious_disease_medical",
      "deduct_tp1_lifestyle",
      "deduct_tp1_sports_equipment",
      "deduct_tp1_other",
    ]
    const [agg, pcbAllowanceAgg, pcbExemptedAgg, byCategory, tp1Agg] =
      await Promise.all([
      prisma.payslip.aggregate({
        where: submittedPayslipFilter,
        _sum: {
          proratedPay: true,
          otPay: true,
          epfEmployee: true,
          socsoEmployee: true,
          skbbkEmployee: true,
          eisEmployee: true,
          pcb: true,
          zakat: true,
        },
      }),
      // PCB-taxable allowances only — sum ALLOWANCE-kind line items
      // whose `subjectToPcb` flag was true at write time. This is what
      // feeds next month's `Y` on the LHDN PCB form, so PCB-exempt
      // allowances (parking, meal, official-duty travel, etc.) must
      // be excluded. Earlier this summed `Payslip.totalAllowances`,
      // which is the FULL cash allowance total — including PCB-exempt
      // rows — and falsely inflated Y for restricted-admin runs.
      //
      // Two sums returned here — see the combined-formula comment
      // below for how they resolve to the per-line COALESCE
      // (pcbTaxableAmount, amount) semantic we actually want.
      prisma.payslipLineItem.aggregate({
        where: {
          kind: "ALLOWANCE",
          subjectToPcb: true,
          payslip: submittedPayslipFilter,
        },
        _sum: { amount: true, pcbTaxableAmount: true },
      }),
      // Rows where `pcbTaxableAmount` was written (i.e. clamped by a
      // `taxExemptLimit` category at write time). Used to substitute
      // their `amount` with the clamped `pcbTaxableAmount` in the
      // total below — otherwise those rows would double-count the
      // exempt portion into next month's Y.
      prisma.payslipLineItem.aggregate({
        where: {
          kind: "ALLOWANCE",
          subjectToPcb: true,
          pcbTaxableAmount: { not: null },
          payslip: submittedPayslipFilter,
        },
        _sum: { amount: true },
      }),
      // Group ALL non-null-category line items (allowances AND TP1
      // deductions) by category — used for per-category cap
      // enforcement (existing childcare cap + new TP1 caps).
      prisma.payslipLineItem.groupBy({
        by: ["category"],
        where: {
          category: { not: null },
          payslip: submittedPayslipFilter,
        },
        _sum: { amount: true },
      }),
      // Sum of TP1 line items across all sub-categories — feeds ∑LP.
      prisma.payslipLineItem.aggregate({
        where: {
          kind: "DEDUCTION",
          category: { in: tp1Categories },
          payslip: submittedPayslipFilter,
        },
        _sum: { amount: true },
      }),
    ])

    const ytdAllowanceByCategory: Record<string, number> = {}
    for (const row of byCategory) {
      if (!row.category) continue
      ytdAllowanceByCategory[row.category] = toNumber(row._sum.amount, 0)
    }

    // Per-line COALESCE(pcbTaxableAmount, amount) semantics, computed
    // from two aggregates because Prisma's `_sum` can't do arithmetic
    // per row:
    //   allocatedTaxable
    //     = SUM(amount WHERE pcbTaxableAmount IS NULL)  ← full amount for legacy / no-cap rows
    //     + SUM(pcbTaxableAmount WHERE pcbTaxableAmount IS NOT NULL)  ← clamped amount for capped rows
    //     = (allAmount − exemptedRowsAmount) + pcbTaxableAggregate
    //
    // Fixes the taxExemptLimit YTD leak: a travel-official RM 1,500
    // that was fully exempt in Jan (Y=19,000) previously came back in
    // Feb's ytdTaxable as 1,500 (Y=20,500), pushing PCB up by ~RM 34/mo
    // and compounding through the year.
    const pcbAllowanceTotalAmount = toNumber(pcbAllowanceAgg._sum.amount, 0)
    const pcbExemptedAmount = toNumber(pcbExemptedAgg._sum.amount, 0)
    const pcbTaxableFromClamped = toNumber(
      pcbAllowanceAgg._sum.pcbTaxableAmount,
      0,
    )
    const pcbAllowanceTaxable =
      pcbAllowanceTotalAmount - pcbExemptedAmount + pcbTaxableFromClamped

    return {
      ytdTaxable:
        toNumber(agg._sum.proratedPay, 0) +
        pcbAllowanceTaxable +
        toNumber(agg._sum.otPay, 0),
      // ytdPcb intentionally uses only Payslip.pcb (formula-calculated
      // portion). Payslip.cp38 + Payslip.voluntaryPcb are EXCLUDED per
      // LHDN MTD Spec 2026 page 14 X-definition: "shall NOT include
      // additional Monthly Tax Deduction requested by the employee and
      // payment of tax installment."
      ytdEpf: toNumber(agg._sum.epfEmployee, 0),
      ytdPcb: toNumber(agg._sum.pcb, 0),
      ytdZakat: toNumber(agg._sum.zakat, 0),
      ytdSocsoEis:
        toNumber(agg._sum.socsoEmployee, 0) +
        toNumber(agg._sum.skbbkEmployee, 0) +
        toNumber(agg._sum.eisEmployee, 0),
      ytdAllowanceByCategory,
      ytdAllowableDeductions: toNumber(tp1Agg._sum.amount, 0),
    }
  },

  /**
   * Per-employee YTD totals for the payslip PDF's "Year to Date" block.
   * Pulls every SUBMITTED payslip for the employee in the given calendar
   * year up to AND INCLUDING the period (year, month) of the payslip
   * being rendered — so a Feb payslip shows Jan+Feb cumulative, etc.
   * Different shape from `getYtdForEmployee` (which excludes the current
   * month to feed PCB inputs); this one is purely for display.
   *
   * Returns gross + net + employee/employer split for the four
   * statutory items + HRDF. Zero everywhere when the employee has no
   * submitted history yet.
   */
  async getYtdSummaryThroughPeriod(input: {
    employeeProfileId: string
    year: number
    month: number
  }): Promise<{
    gross: number
    net: number
    epfEmployee: number
    epfEmployer: number
    socsoEmployee: number
    socsoEmployer: number
    eisEmployee: number
    eisEmployer: number
    pcb: number
    hrdf: number
  }> {
    const empty = {
      gross: 0,
      net: 0,
      epfEmployee: 0,
      epfEmployer: 0,
      socsoEmployee: 0,
      socsoEmployer: 0,
      eisEmployee: 0,
      eisEmployer: 0,
      pcb: 0,
      hrdf: 0,
    }
    const prisma = getPrismaClient()
    if (!prisma) return empty
    const agg = await prisma.payslip.aggregate({
      where: {
        employeeProfileId: input.employeeProfileId,
        payrollRun: {
          status: "SUBMITTED",
          periodYear: input.year,
          // Calendar-year YTD through and including the rendered
          // payslip's period — Jan→Jan, Feb→Jan+Feb, etc.
          periodMonth: { lte: input.month },
        },
      },
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
        voluntaryPcb: true,
        hrdf: true,
      },
    })
    return {
      gross: toNumber(agg._sum.grossPay, 0),
      net: toNumber(agg._sum.netPay, 0),
      epfEmployee: toNumber(agg._sum.epfEmployee, 0),
      epfEmployer: toNumber(agg._sum.epfEmployer, 0),
      socsoEmployee: toNumber(agg._sum.socsoEmployee, 0),
      socsoEmployer: toNumber(agg._sum.socsoEmployer, 0),
      eisEmployee: toNumber(agg._sum.eisEmployee, 0),
      eisEmployer: toNumber(agg._sum.eisEmployer, 0),
      // Year-to-date PCB DISPLAY = total tax actually withheld = formula
      // PCB + Additional PCB (Employment Income). This is the "total
      // withheld" figure for the payslip's YTD block, so it matches the
      // folded monthly PCB. NOTE: this is intentionally different from the
      // formula baseline `ytdPcb` in getYtdForEmployee (which EXCLUDES
      // voluntaryPcb per LHDN MTD Spec p.14 so the manual top-up never
      // carries forward into next month's MTD calculation).
      pcb: toNumber(agg._sum.pcb, 0) + toNumber(agg._sum.voluntaryPcb, 0),
      hrdf: toNumber(agg._sum.hrdf, 0),
    }
  },

  /**
   * Lightweight per-employee identity bag used by the bulk payslip PDF
   * header (IC / passport, join date, statutory reference numbers,
   * bank info). Read live from `PayrollProfile`, not snapshotted onto
   * the payslip — the snapshot's source of truth is the totals + line
   * items; identity is allowed to drift with profile edits.
   */
  async getPayslipHeaderIdentity(input: {
    employeeProfileId: string
  }): Promise<{
    idNumber: string | null
    joinDate: Date | null
    paymentMethod: string
    bankName: string | null
    bankAccountNumber: string | null
    epfNumber: string | null
    socsoNumber: string | null
    incomeTaxNumber: string | null
  } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.payrollProfile.findUnique({
      where: { employeeProfileId: input.employeeProfileId },
      select: {
        idNumber: true,
        joinDate: true,
        paymentMethod: true,
        bankName: true,
        bankAccountNumber: true,
        epfNumber: true,
        socsoNumber: true,
        incomeTaxNumber: true,
      },
    })
    if (!row) return null
    return {
      idNumber: row.idNumber,
      joinDate: row.joinDate,
      paymentMethod: row.paymentMethod,
      bankName: row.bankName,
      bankAccountNumber: row.bankAccountNumber,
      epfNumber: row.epfNumber,
      socsoNumber: row.socsoNumber,
      incomeTaxNumber: row.incomeTaxNumber,
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
   * Fetch the payslip for one employee in one run, with line items.
   * Used by the adjustment-view modal on IMPORTED runs, where the
   * per-employee allowances live on Payslip.lineItems instead of
   * PayrollRunAdjustment.manualLineItems.
   */
  async getByRunAndEmployee(input: {
    payrollRunId: string
    employeeProfileId: string
  }): Promise<PayslipData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.payslip.findFirst({
      where: {
        payrollRunId: input.payrollRunId,
        employeeProfileId: input.employeeProfileId,
      },
      include: {
        lineItems: { orderBy: { id: "asc" } },
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
    unpaidLeaveDays:
      row.unpaidLeaveDays == null ? null : toNumber(row.unpaidLeaveDays, 0),
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
    // SKBBK columns landed mid-2026; default to 0 on older rows so
    // historical payslips still map cleanly.
    skbbkEmployee: toNumber(row.skbbkEmployee, 0),
    skbbkWage: toNumber(row.skbbkWage, 0),
    // Snapshot defaults false on rows written before the column
    // existed; the backfill script flips it TRUE where skbbkEmployee
    // > 0 so already-remitted amounts stay attributed correctly.
    contributeToSkbbk: row.contributeToSkbbk === true,
    pcb: toNumber(row.pcb, 0),
    // CP38 arrears — new column, defaults to 0 on rows written before
    // the column existed so historical payslips map cleanly.
    cp38: toNumber(row.cp38, 0),
    // Additional PCB (Employment Income) — new column, defaults to 0 on
    // rows written before it existed.
    voluntaryPcb: toNumber(row.voluntaryPcb, 0),
    // LHDN PCB formula breakdown — null on rows generated before the
    // `pcbCalculation` column existed; the PDF renderer falls back to
    // a single-line summary in that case.
    pcbCalculation: (row.pcbCalculation ?? null) as unknown,
    hrdf: toNumber(row.hrdf, 0),
    zakat: toNumber(row.zakat, 0),
    hrdfWage: toNumber(row.hrdfWage, 0),
    grossPay: toNumber(row.grossPay, 0),
    netPay: toNumber(row.netPay, 0),
    netShortfall: toNumber(row.netShortfall, 0),
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
    pcbTaxableAmount:
      row.pcbTaxableAmount == null ? null : toNumber(row.pcbTaxableAmount, 0),
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
  // Amount fields were added after the EPF AR fix. Old payslips don't
  // have them — return undefined (rather than 0) so renderers can
  // distinguish "no voluntary" from "old payslip with unknown split"
  // and fall back to a single combined line in that case.
  const mandatoryAmountEmployee =
    v.mandatoryAmountEmployee !== undefined
      ? toNum(v.mandatoryAmountEmployee)
      : undefined
  const mandatoryAmountEmployer =
    v.mandatoryAmountEmployer !== undefined
      ? toNum(v.mandatoryAmountEmployer)
      : undefined
  const voluntaryAmountEmployee =
    v.voluntaryAmountEmployee !== undefined
      ? toNum(v.voluntaryAmountEmployee)
      : undefined
  const voluntaryAmountEmployer =
    v.voluntaryAmountEmployer !== undefined
      ? toNum(v.voluntaryAmountEmployer)
      : undefined
  return {
    employee: toNum(v.employee),
    employer: toNum(v.employer),
    voluntaryEmployee: toNum(v.voluntaryEmployee),
    voluntaryEmployer: toNum(v.voluntaryEmployer),
    mandatoryAmountEmployee,
    mandatoryAmountEmployer,
    voluntaryAmountEmployee,
    voluntaryAmountEmployer,
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
