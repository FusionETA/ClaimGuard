import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import { calcPayslip } from "@/modules/payroll/domain/calc"
import { periodLabel } from "@/modules/payroll/domain/runs"
import type {
  FixedAllowance,
  PayrollEmployeeRow,
} from "@/modules/payroll/domain/models"
import type {
  AttachableClaimRow,
  PayrollRunAdjustmentData,
  PayrollRunClaimRow,
  PayrollRunData,
  PayrollRunRow,
  PayslipData,
  PayslipRow,
} from "@/modules/payroll/domain/runs"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { payrollRunAdjustmentRepository } from "@/modules/payroll/infrastructure/payroll-run-adjustment.repository"
import { payrollRunClaimRepository } from "@/modules/payroll/infrastructure/payroll-run-claim.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import {
  payslipRepository,
  type CreatePayslipInput,
} from "@/modules/payroll/infrastructure/payslip.repository"

/**
 * Page-data + action services for the "Payroll → Runs" surface.
 *
 * Same guard pattern as the rest of the payroll module: admin-only,
 * scoped to the active org via `resolveActiveOrgId(session)`.
 *
 * Phase 3 scope is the run SHELL only — create draft, list, view
 * eligible employees, delete draft. Payslip generation + submit land
 * in Phase 4 alongside the calculation engine.
 */

// ─── Page data ───────────────────────────────────────────────────────────

export async function getPayrollRunsPageData(): Promise<{
  organizationName: string
  runs: PayrollRunRow[]
  eligibleEmployeeCount: number
} | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const [org, runs, employees] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunRepository.listForOrganization(orgId),
    payrollProfileRepository.listForOrganization(orgId),
  ])

  return {
    organizationName: org?.name ?? "",
    runs,
    eligibleEmployeeCount: employees.filter(isReadyForPayroll).length,
  }
}

export async function getPayrollRunDetailPageData(input: {
  runId: string
}): Promise<{
  organizationName: string
  run: PayrollRunRow
  /// Every employee in the org with a PayrollProfile, with a flag for
  /// whether they're "ready" (complete + not archived). Used by the
  /// run detail page to preview who will be on the payslip generator.
  employees: Array<PayrollEmployeeRow & { ready: boolean }>
} | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const [org, run, employees] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunRepository.getByIdForOrg({
      id: input.runId,
      organizationId: orgId,
    }),
    payrollProfileRepository.listForOrganization(orgId),
  ])

  if (!run) return null

  return {
    organizationName: org?.name ?? "",
    run,
    employees: employees.map((e) => ({
      ...e,
      ready: isReadyForPayroll(e),
    })),
  }
}

// ─── Mutations ───────────────────────────────────────────────────────────

export async function createPayrollRunDraft(input: {
  periodYear: number
  periodMonth: number
}): Promise<PayrollRunData> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  // Short-circuit if a run already exists for this period — gives a
  // friendlier error than the DB unique-constraint violation.
  const existing = await payrollRunRepository.findByPeriod({
    organizationId: orgId,
    periodYear: input.periodYear,
    periodMonth: input.periodMonth,
  })
  if (existing) {
    throw new Error(
      "A payroll run already exists for this period. Open it instead of creating a new one.",
    )
  }

  const nextSubmitted = await payrollRunRepository.findNextSubmittedAfterPeriod({
    organizationId: orgId,
    periodYear: input.periodYear,
    periodMonth: input.periodMonth,
  })
  if (nextSubmitted) {
    throw new Error(
      `Cannot create a draft for ${periodLabel(input.periodYear, input.periodMonth)} because ${periodLabel(nextSubmitted.periodYear, nextSubmitted.periodMonth)} has already been submitted. Revert the later run to draft first if you need to backfill an earlier period.`,
    )
  }

  return payrollRunRepository.createDraft({
    organizationId: orgId,
    periodYear: input.periodYear,
    periodMonth: input.periodMonth,
  })
}

/**
 * Submit a draft run. Locks the run as immutable — claim attachments
 * can no longer be added/removed, payslips can no longer be
 * regenerated. Captures `submittedAt` + `submittedById` for audit.
 *
 * Pre-conditions: run is DRAFT and has at least one payslip on file
 * (we don't want to submit an empty run).
 */
export async function submitPayrollRun(input: {
  runId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error("Run has already been submitted.")
  }
  if (run.payslipCount === 0) {
    throw new Error(
      "Run payroll before submitting — an empty run can't be finalised.",
    )
  }

  await payrollRunRepository.submit({
    id: run.id,
    organizationId: orgId,
    submittedById: session.userId,
  })
}

/**
 * Reverse a submitted run back to DRAFT. Existing payslips + claim
 * attachments stay attached — admin can edit and re-submit. Used when
 * payroll data was wrong and the run needs adjusting after submit.
 */
export async function revertPayrollRunToDraft(input: {
  runId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  await payrollRunRepository.revertToDraft({
    id: input.runId,
    organizationId: orgId,
  })
}

export async function deletePayrollRunDraft(input: {
  runId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  await payrollRunRepository.deleteDraft({
    id: input.runId,
    organizationId: orgId,
  })
}

/**
 * Generate payslips for every ready employee on a draft run.
 *
 * Order:
 *   1. Verify the run exists in this org and is still DRAFT.
 *   2. Load org PayrollSettings (fall back to schema defaults).
 *   3. Pull all employees with complete + non-archived payroll profiles.
 *   4. Run `calcPayslip` per employee.
 *   5. Atomically delete existing payslips + write the fresh batch.
 *   6. Refresh the run's cached totals.
 *
 * Returns the number of payslips generated. Safe to call repeatedly —
 * each call recomputes from scratch, so payroll settings or profile
 * changes show up on the next "Generate" press.
 */
export async function generatePayrollPayslips(input: {
  runId: string
}): Promise<{ count: number }> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error("Only draft runs can be run again.")
  }

  const [settings, employees, attachments, adjustments] = await Promise.all([
    payrollSettingsRepository.getByOrgId(orgId),
    payrollProfileRepository.listReadyForPayroll(orgId),
    payrollRunClaimRepository.listForCalc(run.id),
    payrollRunAdjustmentRepository.listForRun(run.id),
  ])

  if (employees.length === 0) {
    throw new Error(
      "No employees are ready for payroll. Complete at least one employee's payroll profile and try again.",
    )
  }

  // Group reimbursement attachments by employee for fast per-loop
  // lookup. Each attachment row maps to one REIMBURSEMENT line item.
  const reimbursementsByEmp = new Map<
    string,
    Array<{ id: string; label: string; amount: number }>
  >()
  for (const a of attachments) {
    const list = reimbursementsByEmp.get(a.employeeProfileId) ?? []
    list.push({ id: a.claimId, label: a.label, amount: a.amount })
    reimbursementsByEmp.set(a.employeeProfileId, list)
  }

  // Fall back to schema defaults if no PayrollSettings row exists yet.
  // These match the Prisma defaults (otRateNormal 1.5, etc.).
  const calcSettings = {
    otRateNormal: settings?.otRateNormal ?? 1.5,
    otRateRest: settings?.otRateRest ?? 2,
    otRatePublicHoliday: settings?.otRatePublicHoliday ?? 3,
    workingDaysRule: settings?.workingDaysRule ?? "TWENTY_SIX",
    defaultEpfEmployeeRate: settings?.defaultEpfEmployeeRate ?? 11,
    defaultEpfEmployerRate: settings?.defaultEpfEmployerRate ?? 13,
    hrdfEnabled: settings?.hrdfEnabled ?? false,
    hrdfRate: settings?.hrdfRate ?? null,
    // Default ON when the row is missing (new orgs) so admins get
    // the HReasily-style monthly PCB out of the box. Turn off if
    // strict LHDN-TP1 reading is preferred.
    autoApplySocsoEisRelief: settings?.autoApplySocsoEisRelief ?? true,
  } as const

  // Fetch YTD per-employee in parallel (needed for the PCB calc).
  // Excludes this current draft so the figure represents what's
  // already finalised. Prev-employer carryover gets folded in below.
  const ytdEntries = await Promise.all(
    employees.map(async (e) => {
      const ytd = await payslipRepository.getYtdForEmployee({
        employeeProfileId: e.employeeProfileId,
        year: run.periodYear,
        excludeRunId: run.id,
      })
      // Add prev-employer TP3-like carryover when the employee joined
      // this year (prev income from a different employer in the same
      // calendar year — pulled from the payroll profile).
      const joinedThisYear =
        e.profile.joinDate &&
        new Date(e.profile.joinDate).getUTCFullYear() === run.periodYear
      const isPrevForSameYear =
        joinedThisYear && (e.profile.prevEmploymentYear ?? null) === run.periodYear
      return {
        empId: e.employeeProfileId,
        // TP3 carryover: add the prev-employer figures to each YTD
        // bucket only when the employee's `prevEmploymentYear` equals
        // the current run's calendar year. Per LHDN MTD Spec § 10
        // (page 23) the TP3 form provides (Y-K), X, Z, ΣLP.
        ytdTaxable:
          ytd.ytdTaxable + (isPrevForSameYear ? e.profile.prevRemuneration ?? 0 : 0),
        ytdEpf: ytd.ytdEpf + (isPrevForSameYear ? e.profile.prevEpf ?? 0 : 0),
        ytdPcb: ytd.ytdPcb + (isPrevForSameYear ? e.profile.prevPcb ?? 0 : 0),
        ytdZakat:
          ytd.ytdZakat + (isPrevForSameYear ? e.profile.prevZakat ?? 0 : 0),
        // Prev-employer SOCSO+EIS carryover is intentionally omitted —
        // the RM 350 cap saturates at typical contribution levels
        // within the first ~3-4 months, so a mid-year joiner converges
        // to the same answer with or without the prior-employer
        // figure. (We could add a `prevSocsoEis` profile field later
        // if needed for early-year joiners, but the PCB delta is
        // typically < RM 5 / month.)
        ytdSocsoEis: ytd.ytdSocsoEis,
        ytdAllowanceByCategory: ytd.ytdAllowanceByCategory,
      }
    }),
  )
  const ytdByEmp = new Map(ytdEntries.map((y) => [y.empId, y]))

  const payslips: CreatePayslipInput[] = employees.map((e) => {
    const adj = adjustments.get(e.employeeProfileId) ?? null
    const ytd = ytdByEmp.get(e.employeeProfileId)
    // Apply per-run overrides to the profile's fixed adjustments:
    // - `skip: true` → drop the row for this run
    // - `amount: number` → replace amount but preserve `category` so
    //   the EPF/SOCSO/EIS/PCB subject-to flags follow through
    // - missing index → use the profile default
    const overrides = adj?.fixedAllowanceOverrides ?? {}
    const overriddenFixed: typeof e.profile.fixedAllowances = []
    e.profile.fixedAllowances.forEach((a, i) => {
      const override = overrides[String(i)]
      if (!override) {
        overriddenFixed.push(a)
        return
      }
      if (override.skip) return
      if (override.amount != null) {
        overriddenFixed.push({ ...a, amount: override.amount })
        return
      }
      overriddenFixed.push(a)
    })

    // Merge one-off line items (allowances + deductions) into the
    // profile snapshot. The calc engine's fixedAllowances loop
    // dispatches on `meta.kind` (ALLOWANCE / DEDUCTION /
    // REIMBURSEMENT) and applies statutory flags via the category
    // meta — so DEDUCTIONs land in the right bucket and respect
    // `reducesBase` / EPF / SOCSO / EIS / PCB. Pre-Phase-19 line
    // items without `category` get safe defaults from the repo
    // parser, so legacy data still works.
    const oneOffLines = (adj?.manualLineItems ?? []).map((li) => ({
      category: li.category as (typeof overriddenFixed)[number]["category"],
      name: li.label,
      amount: li.amount,
    }))
    const profileWithAdjAllowances = {
      ...e.profile,
      fixedAllowances: [...overriddenFixed, ...oneOffLines],
    }

    const result = calcPayslip({
      profile: profileWithAdjAllowances,
      settings: calcSettings,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
      // OT hours: from the admin's per-employee adjustment row.
      otNormalHours: adj?.otNormalHours ?? 0,
      otRestHours: adj?.otRestHours ?? 0,
      otPublicHours: adj?.otPublicHours ?? 0,
      // Reimbursements: pre-attached PayrollRunClaim rows for this
      // employee. The claim id flows through to the generated
      // PayslipLineItem's `claimId` FK for traceability.
      reimbursements: reimbursementsByEmp.get(e.employeeProfileId) ?? [],
      // One-off deductions are now merged into `fixedAllowances`
      // above so they go through the category-aware path. Keep the
      // engine input empty — no double-counting. (Unpaid leave is
      // one of those line items now — category `deduct_unpaid_leave`.)
      manualDeductions: [],
      // PCB year-to-date inputs (this year's SUBMITTED payslips +
      // prev-employer TP3-like carryover).
      ytdTaxable: ytd?.ytdTaxable ?? 0,
      ytdEpf: ytd?.ytdEpf ?? 0,
      ytdPcb: ytd?.ytdPcb ?? 0,
      ytdZakat: ytd?.ytdZakat ?? 0,
      ytdSocsoEis: ytd?.ytdSocsoEis ?? 0,
      // YTD per-category allowance totals — drives taxExemptLimit
      // enforcement for parking / childcare / award etc. caps.
      ytdAllowanceByCategory: ytd?.ytdAllowanceByCategory ?? {},
    })

    return {
      employeeProfileId: e.employeeProfileId,
      payrollProfileId: e.profile.id,
      snapshotName: e.name,
      snapshotEmployeeId: e.employeeId,
      snapshotPosition: e.jobTitle,
      snapshotSalaryType: e.profile.salaryType,
      snapshotMonthlySalary: e.profile.monthlySalary,
      snapshotHourlyRate: e.profile.hourlyRate,
      snapshotNationality: e.profile.nationality,
      snapshotIsResident: e.profile.isResident,
      snapshotEpfRates: result.epfRatesSnapshot,
      basicPay: result.basicPay,
      proratedPay: result.proratedPay,
      workedHours: result.workedHours,
      proratedFactor: result.proratedFactor,
      proratedDays: result.proratedDays,
      totalWorkingDays: result.totalWorkingDays,
      otNormalHours: result.otNormalHours,
      otRestHours: result.otRestHours,
      otPublicHours: result.otPublicHours,
      otPay: result.otPay,
      totalAllowances: result.totalAllowances,
      totalReimbursements: result.totalReimbursements,
      totalDeductions: result.totalDeductions,
      epfEmployee: result.epfEmployee,
      epfEmployer: result.epfEmployer,
      socsoEmployee: result.socsoEmployee,
      socsoEmployer: result.socsoEmployer,
      eisEmployee: result.eisEmployee,
      eisEmployer: result.eisEmployer,
      pcb: result.pcb,
      hrdf: result.hrdf,
      hrdfWage: result.hrdfWage,
      zakat: result.zakat,
      grossPay: result.grossPay,
      netPay: result.netPay,
      totalCostToEmployer: result.totalCostToEmployer,
      lineItems: result.lineItems,
    }
  })

  const count = await payslipRepository.replacePayslipsForRun({
    payrollRunId: run.id,
    payslips,
  })

  await payslipRepository.refreshRunTotals({ payrollRunId: run.id })

  return { count }
}

// ─── Payslip read paths ──────────────────────────────────────────────────

/**
 * Extended detail-page data for the run page — adds the list of
 * payslips, the list of claim attachments, and the list of further
 * attachable claims so the admin can manage reimbursements in one
 * place.
 */
/** Lightweight summary of a PayrollRunAdjustment, for inline
 *  display on the "ready employees" table BEFORE payroll generation.
 *  Mirrors what the admin tends to glance at: OT hour totals + how
 *  many one-off line items + whether any recurring allowance is
 *  overridden for this run. */
export type RunEmployeeAdjustmentSummary = {
  otNormalHours: number
  otRestHours: number
  otPublicHours: number
  /// Count of manual ALLOWANCE-kind line items.
  allowanceCount: number
  /// Count of manual DEDUCTION-kind line items.
  deductionCount: number
  /// Count of recurring fixed-allowance rows the admin overrode for
  /// this run (amount changed or skipped).
  overrideCount: number
  /// Whether the admin has left an audit note on this adjustment.
  hasNote: boolean
}

export async function getPayrollRunDetailWithPayslipsPageData(input: {
  runId: string
}): Promise<{
  organizationName: string
  run: PayrollRunRow
  employees: Array<
    PayrollEmployeeRow & {
      ready: boolean
      /// Per-run adjustment summary. Null when the admin hasn't
      /// edited OT or added any line items for this employee yet.
      adjustment: RunEmployeeAdjustmentSummary | null
    }
  >
  payslips: PayslipRow[]
  attachments: PayrollRunClaimRow[]
  attachableClaims: AttachableClaimRow[]
} | null> {
  const base = await getPayrollRunDetailPageData(input)
  if (!base) return null

  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const [payslips, attachments, attachableClaims, adjustments] =
    await Promise.all([
      payslipRepository.listForRun(input.runId),
      payrollRunClaimRepository.listForRun(input.runId),
      payrollRunClaimRepository.listAttachableForOrg({
        organizationId: orgId,
        excludeAttached: true,
      }),
      payrollRunAdjustmentRepository.listForRun(input.runId),
    ])

  // Project every PayrollRunAdjustment row into a serialisable
  // summary, keyed by employeeProfileId. The "Will be included"
  // table reads these so admins can see who has OT / line items
  // set before clicking Generate.
  const summariesByEmp = new Map<string, RunEmployeeAdjustmentSummary>()
  for (const [empId, adj] of adjustments.entries()) {
    let allowanceCount = 0
    let deductionCount = 0
    for (const li of adj.manualLineItems) {
      if (li.kind === "ALLOWANCE") allowanceCount += 1
      else if (li.kind === "DEDUCTION") deductionCount += 1
    }
    let overrideCount = 0
    for (const v of Object.values(adj.fixedAllowanceOverrides ?? {})) {
      if (v.skip || v.amount != null) overrideCount += 1
    }
    summariesByEmp.set(empId, {
      otNormalHours: adj.otNormalHours,
      otRestHours: adj.otRestHours,
      otPublicHours: adj.otPublicHours,
      allowanceCount,
      deductionCount,
      overrideCount,
      hasNote:
        typeof adj.notes === "string" && adj.notes.trim().length > 0,
    })
  }

  const enrichedEmployees = base.employees.map((e) => ({
    ...e,
    adjustment: summariesByEmp.get(e.employeeProfileId) ?? null,
  }))

  return {
    ...base,
    employees: enrichedEmployees,
    payslips,
    attachments,
    attachableClaims,
  }
}

// ─── Bank disbursement (Phase 10) ────────────────────────────────────────

/**
 * One row per payslip in the format banks expect for bulk transfer
 * uploads. Built from PayrollProfile snapshots on the run via a
 * fresh lookup against the live profile — banks need the *current*
 * account info, not the snapshot from generation time. If the
 * employee updates their account between generate and submit, the
 * latest details win.
 */
export type DisbursementRow = {
  sequence: number
  employeeCode: string
  employeeName: string
  bankName: string
  accountHolderName: string
  accountNumber: string
  currency: string
  netAmount: number
  reference: string
}

export async function getPayrollDisbursementRows(input: {
  runId: string
}): Promise<{
  organizationName: string
  run: PayrollRunRow
  rows: DisbursementRow[]
} | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) return null

  // Pull every payslip on the run + the LIVE bank details from the
  // employee's PayrollProfile (not the snapshot — banks want current
  // account info).
  const payslips = await prisma.payslip.findMany({
    where: { payrollRunId: run.id },
    orderBy: { snapshotEmployeeId: "asc" },
    include: {
      payrollProfile: {
        select: {
          bankName: true,
          bankAccountHolderName: true,
          bankAccountNumber: true,
        },
      },
    },
  })

  const [org] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
  ])

  const periodTag = `${run.periodYear}${String(run.periodMonth).padStart(2, "0")}`
  const rows: DisbursementRow[] = payslips.map((p, i) => {
    return {
      sequence: i + 1,
      employeeCode: p.snapshotEmployeeId,
      employeeName: p.snapshotName,
      bankName: p.payrollProfile?.bankName ?? "",
      accountHolderName:
        p.payrollProfile?.bankAccountHolderName ?? p.snapshotName,
      accountNumber: p.payrollProfile?.bankAccountNumber ?? "",
      currency: "MYR",
      netAmount: Number(p.netPay) || 0,
      reference: `Payroll ${periodTag} ${p.snapshotEmployeeId}`,
    }
  })

  return {
    organizationName: org?.name ?? "",
    run,
    rows,
  }
}

// ─── Per-employee adjustments (Phase 7) ─────────────────────────────────

/**
 * Page-data for the per-employee adjustment form. Returns the
 * employee identity, the existing adjustment row (or null), and the
 * parent run so the form can render with full context.
 */
export async function getPayrollAdjustmentPageData(input: {
  runId: string
  employeeProfileId: string
}): Promise<{
  organizationName: string
  run: PayrollRunRow
  employee: {
    employeeProfileId: string
    userId: string
    employeeCode: string
    name: string
    email: string
    jobTitle: string
    salaryType: "MONTHLY" | "HOURLY"
    monthlySalary: number | null
    hourlyRate: number | null
  }
  /// Profile-level recurring adjustments — shown read-only on the form
  /// so admins can override them per-run (Phase 18).
  fixedAllowances: FixedAllowance[]
  adjustment: PayrollRunAdjustmentData | null
} | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) return null

  // Resolve the employee identity + payroll profile (for compensation
  // context shown in the form header).
  const profileRow = await prisma.employeeProfile.findFirst({
    where: {
      id: input.employeeProfileId,
      user: { organizationId: orgId },
    },
    select: {
      id: true,
      employeeId: true,
      jobTitle: true,
      user: { select: { id: true, name: true, email: true } },
      payrollProfile: {
        select: {
          salaryType: true,
          monthlySalary: true,
          hourlyRate: true,
        },
      },
    },
  })
  if (!profileRow) return null

  const [org, adjustment, payrollProfile] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunAdjustmentRepository.getOne({
      payrollRunId: run.id,
      employeeProfileId: input.employeeProfileId,
    }),
    // Pulled via the repo so the JSON column is already parsed +
    // typed. Used by the form to render the per-run overrides card.
    payrollProfileRepository.getByEmployeeProfileId(input.employeeProfileId),
  ])

  return {
    organizationName: org?.name ?? "",
    run,
    employee: {
      employeeProfileId: profileRow.id,
      userId: profileRow.user.id,
      employeeCode: profileRow.employeeId,
      name: profileRow.user.name,
      email: profileRow.user.email,
      jobTitle: profileRow.jobTitle,
      salaryType:
        (profileRow.payrollProfile?.salaryType as "MONTHLY" | "HOURLY") ??
        "MONTHLY",
      monthlySalary: profileRow.payrollProfile?.monthlySalary
        ? Number(profileRow.payrollProfile.monthlySalary)
        : null,
      hourlyRate: profileRow.payrollProfile?.hourlyRate
        ? Number(profileRow.payrollProfile.hourlyRate)
        : null,
    },
    fixedAllowances: payrollProfile?.fixedAllowances ?? [],
    adjustment,
  }
}

/**
 * Upsert an adjustment row. Verifies the run is in this org + still
 * DRAFT before writing.
 */
export async function savePayrollAdjustment(input: {
  runId: string
  employeeProfileId: string
  patch: Parameters<typeof payrollRunAdjustmentRepository.upsert>[0]["patch"]
}): Promise<PayrollRunAdjustmentData> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error(
      "This run is submitted — revert it to draft before editing adjustments.",
    )
  }

  return payrollRunAdjustmentRepository.upsert({
    payrollRunId: run.id,
    employeeProfileId: input.employeeProfileId,
    patch: input.patch,
  })
}

/**
 * Clear the entire adjustment row for an employee on this run.
 */
export async function clearPayrollAdjustment(input: {
  runId: string
  employeeProfileId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error(
      "This run is submitted — revert it to draft before clearing adjustments.",
    )
  }

  await payrollRunAdjustmentRepository.deleteOne({
    payrollRunId: run.id,
    employeeProfileId: input.employeeProfileId,
  })
}

// ─── Claim attachment mutations ──────────────────────────────────────────

/**
 * Attach a SYNCED, PERSONAL paymentType claim to a draft payroll run.
 * Snapshots the claim's title + amount at attach time so later edits
 * to the claim don't change payroll history.
 */
export async function attachClaimToPayrollRun(input: {
  runId: string
  claimId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  // 1. Verify the run exists in this org and is still DRAFT.
  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "DRAFT") {
    throw new Error(
      "This run has been submitted and can no longer accept new reimbursements.",
    )
  }

  // 2. Verify the claim, scoped to the same org.
  const claim = await payrollRunClaimRepository.getClaimForAttach({
    claimId: input.claimId,
    organizationId: orgId,
  })
  if (!claim) throw new Error("Claim not found in this organisation.")
  if (claim.alreadyAttachedRunId) {
    throw new Error(
      "This claim is already attached to a payroll run. Detach it first.",
    )
  }
  if (claim.status !== "REVIEWED") {
    throw new Error(
      "Only fully-reviewed claims can be added to payroll. Approve the claim first.",
    )
  }
  if (claim.xeroSyncStatus !== "SYNCED") {
    throw new Error(
      "Sync the claim to Xero before adding it to a payroll run.",
    )
  }
  if (claim.paymentType !== "PERSONAL") {
    throw new Error(
      "Only PERSONAL-paymentType claims need reimbursing through payroll.",
    )
  }
  if (!claim.employeeProfileId) {
    throw new Error(
      "The claim's submitter doesn't have an employee profile, so they can't be paid via payroll.",
    )
  }

  await payrollRunClaimRepository.attach({
    payrollRunId: run.id,
    claimId: claim.id,
    employeeProfileId: claim.employeeProfileId,
    label: claim.title,
    amount: claim.amount,
  })
}

/**
 * Detach a claim from whatever run it's attached to. Only allowed
 * while the run is still DRAFT.
 */
export async function detachClaimFromPayrollRun(input: {
  claimId: string
}): Promise<void> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  // Verify the attached run (if any) belongs to this org AND is DRAFT.
  const claim = await payrollRunClaimRepository.getClaimForAttach({
    claimId: input.claimId,
    organizationId: orgId,
  })
  if (!claim) throw new Error("Claim not found in this organisation.")
  if (!claim.alreadyAttachedRunId) return // nothing to do

  const run = await payrollRunRepository.getByIdForOrg({
    id: claim.alreadyAttachedRunId,
    organizationId: orgId,
  })
  if (run && run.status !== "DRAFT") {
    throw new Error(
      "Cannot detach a claim from a submitted run. Reverse the run first.",
    )
  }

  await payrollRunClaimRepository.detach({ claimId: input.claimId })
}

/**
 * Single-payslip detail (snapshot + line items). Scoped to the admin's
 * active org via the parent run.
 */
export async function getPayrollPayslipDetailPageData(input: {
  payslipId: string
}): Promise<{
  organizationName: string
  payslip: PayslipData
  run: PayrollRunRow
} | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const payslip = await payslipRepository.getByIdForOrg({
    payslipId: input.payslipId,
    organizationId: orgId,
  })
  if (!payslip) return null

  const [org, run] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunRepository.getByIdForOrg({
      id: payslip.payrollRunId,
      organizationId: orgId,
    }),
  ])

  if (!run) return null

  return {
    organizationName: org?.name ?? "",
    payslip,
    run,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * An employee is "ready for payroll" when they have a complete
 * PayrollProfile and are not archived. This is the filter that
 * decides who shows up on a run's draft.
 */
function isReadyForPayroll(row: PayrollEmployeeRow): boolean {
  return row.hasProfile && row.isComplete && !row.isArchived
}
