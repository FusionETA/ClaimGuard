import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { toNumber } from "@/lib/decimal"
import { getPrismaClient } from "@/lib/prisma"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import {
  PAYROLL_XERO_ACCOUNT_LABELS,
  getPayrollAdjustmentLabel,
  type PayrollXeroAccountKey,
  type PayrollXeroMapping,
} from "@/modules/payroll/domain/settings"
import type { PayrollAdjustmentCategory } from "@/modules/payroll/domain/models"

/**
 * Preview the Xero artifacts that will be posted when this payroll
 * run is approved.
 *
 * Returns BOTH:
 *   - bills:   claims attached to this run that will become Xero
 *              Bills (one per claim) when claim Xero sync is enabled.
 *   - journal: the manual-journal lines (same algorithm as the real
 *              sync), so the admin can sanity-check before clicking
 *              Approve.
 *
 * This service does NOT call Xero — it derives everything from the
 * DB. Account codes / tracking names are shown as the category name
 * (e.g. "Salary account") rather than the real Xero code, because
 * the code resolution requires a live Xero call we'd rather not
 * make on every preview. The real sync does the code lookup at
 * post time.
 */
export type PayrollSyncPreviewResult =
  | {
      status: "success"
      preview: PayrollSyncPreview
    }
  | {
      status: "skipped"
      message: string
      /// When the mapping is missing/incomplete we still want to
      /// show the bills + raw amounts so the admin sees what would
      /// have been posted. Optional.
      preview?: PayrollSyncPreview
    }
  | { status: "error"; message: string }

export type PayrollSyncPreview = {
  bills: PreviewBill[]
  /// The single manual journal that will post on run approval.
  /// `lines.length === 0` means the run is empty / nothing to post.
  ///
  /// Note: claim reimbursements are EXCLUDED from this journal.
  /// Each claim posts as a separate Xero Bill during payroll approval
  /// time; including them here would double-count the payable.
  journal: {
    narration: string
    date: string
    lines: PreviewJournalLine[]
    totalDebits: number
    totalCredits: number
    isBalanced: boolean
  }
  /// The agreed payroll/xero mapping the journal was built against,
  /// or null if the mapping hasn't been configured yet. UI uses this
  /// to render a "configure mapping first" banner.
  mapping: PayrollXeroMapping | null
  /// Categories the admin still needs to map an account for. Empty
  /// when the mapping is complete enough to post.
  missingAccountKeys: PayrollXeroAccountKey[]
  /// Per-category allowance / deduction mappings that are missing
  /// AND the run actually uses (i.e. at least one payslip line item
  /// tagged with that category). Drives the red "must fix" banner in
  /// the approval modal.
  missingAllowanceCategories: Array<{
    key: string
    label: string
  }>
  missingDeductionCategories: Array<{
    key: string
    label: string
  }>
  syncEnabled: boolean
  claimsSyncEnabled: boolean
}

export type PreviewBill = {
  claimId: string
  claimNumber: string
  title: string
  employeeName: string
  amount: number
  currency: string
  alreadySynced: boolean
  xeroBillRef: string | null
}

export type PreviewJournalLine = {
  /// Friendly label e.g. "Salary account", "Accrual — EPF". Real
  /// Xero account code is resolved at post time.
  accountLabel: string
  /// Category key — useful for the modal to group / colour-code
  /// lines.
  categoryKey: PayrollXeroAccountKey
  /// Positive = debit, negative = credit.
  amount: number
  description: string
  /// Tracking option (project name) for this line. "(All projects)"
  /// for aggregated employer / accrual lines.
  trackingOption: string | null
}

const REQUIRED_KEYS: PayrollXeroAccountKey[] = [
  "salary",
  "epfEmployer",
  "socsoEmployer",
  "eisEmployer",
  "accrualEpf",
  "accrualSocso",
  "accrualEis",
  "accrualPcb",
  "accrualSalary",
]

export async function buildPayrollSyncPreview(
  payrollRunId: string,
): Promise<PayrollSyncPreviewResult> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired." }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { status: "error", message: "No active organisation." }
  const prisma = getPrismaClient()
  if (!prisma) return { status: "error", message: "Database not configured." }

  const run = await prisma.payrollRun.findFirst({
    where: { id: payrollRunId, organizationId: orgId },
    select: {
      id: true,
      periodYear: true,
      periodMonth: true,
      payslips: {
        select: {
          id: true,
          snapshotName: true,
          snapshotEmployeeId: true,
          basicPay: true,
          proratedPay: true,
          otPay: true,
          totalAllowances: true,
          totalReimbursements: true,
          totalDeductions: true,
          netPay: true,
          epfEmployee: true,
          epfEmployer: true,
          socsoEmployee: true,
          socsoEmployer: true,
          eisEmployee: true,
          eisEmployer: true,
          pcb: true,
          hrdf: true,
          // Line items drive per-category allowance / deduction
          // detection so the modal can surface unmapped categories
          // before the admin clicks Approve.
          lineItems: {
            select: { kind: true, category: true, amount: true },
          },
          employeeProfile: {
            select: {
              projectAssignments: {
                select: {
                  project: { select: { id: true, name: true } },
                },
                take: 1,
              },
            },
          },
        },
      },
      claimAttachments: {
        select: {
          claimId: true,
          label: true,
          amount: true,
          claim: {
            select: {
              claimNumber: true,
              title: true,
              currency: true,
              xeroBillId: true,
              xeroBillRef: true,
            },
          },
          employeeProfile: {
            select: {
              user: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  })

  if (!run) return { status: "error", message: "Payroll run not found." }

  const settings = await payrollSettingsRepository.getByOrgId(orgId)
  const mapping = settings?.xeroMapping ?? null
  const syncEnabled = Boolean(settings?.syncPayrollToXeroOnSubmit)
  const claimsSyncEnabled = Boolean(settings?.syncClaimsToXeroOnSubmit)
  // HRDF accounts are only required when the run actually carries an
  // HRDF charge; the unified `deduction` account only when the run has
  // deductions and the org isn't using per-category deduction mapping.
  const runHasHrdf = run.payslips.some((p) => toNumber(p.hrdf, 0) > 0)
  const runHasDeductions = run.payslips.some((p) =>
    p.lineItems.some(
      (li) => li.kind === "DEDUCTION" && toNumber(li.amount, 0) > 0,
    ),
  )
  const requiredKeys: PayrollXeroAccountKey[] = [...REQUIRED_KEYS]
  if (runHasHrdf) requiredKeys.push("hrdfEmployer", "accrualHrdf")
  if (runHasDeductions && mapping?.deductionMode !== "PER_CATEGORY") {
    requiredKeys.push("deduction")
  }
  const missingAccountKeys = requiredKeys.filter(
    (k) => !(mapping?.accounts ?? {})[k],
  )

  // Per-category mapping coverage check. Walk every payslip line
  // item, group by kind, and flag any category that's referenced AND
  // missing an account when the corresponding mode is PER_CATEGORY.
  // Under UNIFIED mode we skip the per-category check entirely — the
  // unified-account requirement is already covered by the
  // missingAccountKeys check above (`accounts.allowance` /
  // `accounts.deduction`).
  const allowanceCatsOnRun = new Set<string>()
  const deductionCatsOnRun = new Set<string>()
  for (const p of run.payslips) {
    for (const li of p.lineItems) {
      if (!li.category) continue
      if (li.kind === "ALLOWANCE") allowanceCatsOnRun.add(li.category)
      else if (li.kind === "DEDUCTION") deductionCatsOnRun.add(li.category)
    }
  }
  const missingAllowanceCategories =
    mapping?.allowanceMode === "PER_CATEGORY"
      ? Array.from(allowanceCatsOnRun)
          .filter((c) => !mapping.allowanceAccounts[c])
          .map((c) => ({
            key: c,
            label: getPayrollAdjustmentLabel(
              c as PayrollAdjustmentCategory,
            ) || c,
          }))
      : []
  const missingDeductionCategories =
    mapping?.deductionMode === "PER_CATEGORY"
      ? Array.from(deductionCatsOnRun)
          .filter((c) => !mapping.deductionAccounts[c])
          .map((c) => ({
            key: c,
            label: getPayrollAdjustmentLabel(
              c as PayrollAdjustmentCategory,
            ) || c,
          }))
      : []

  const bills: PreviewBill[] = run.claimAttachments.map((attachment) => ({
    claimId: attachment.claimId,
    claimNumber: attachment.claim.claimNumber,
    title: attachment.label || attachment.claim.title,
    employeeName: attachment.employeeProfile.user.name,
    amount: round2(toNumber(attachment.amount, 0)),
    currency: attachment.claim.currency,
    alreadySynced: Boolean(attachment.claim.xeroBillId),
    xeroBillRef: attachment.claim.xeroBillRef,
  }))

  // ── Journal lines preview ──
  // Reuses the same shape/algorithm as syncPayrollRunToXero, but
  // uses the friendly category labels instead of Xero account codes.
  const aggregationMode = mapping?.aggregationMode ?? "SUM_BY_PROJECT"
  const trackingEnabled = Boolean(mapping?.trackingCategoryId)
  const ALL_PROJECTS = "(All projects)"
  const NO_PROJECT = "(No project)"

  const rows = run.payslips.map((p) => ({
    employeeName: p.snapshotName,
    employeeId: p.snapshotEmployeeId,
    projectName:
      p.employeeProfile?.projectAssignments[0]?.project?.name ?? NO_PROJECT,
    // Salary debit is built on proratedPay (matches calc gross), not
    // basicPay — see the note in xero-payroll-sync.service.ts.
    proratedPay: toNumber(p.proratedPay, 0),
    otPay: toNumber(p.otPay, 0),
    totalAllowances: toNumber(p.totalAllowances, 0),
    totalReimbursements: toNumber(p.totalReimbursements, 0),
    totalDeductions: toNumber(p.totalDeductions, 0),
    netPay: toNumber(p.netPay, 0),
    epfEmployee: toNumber(p.epfEmployee, 0),
    epfEmployer: toNumber(p.epfEmployer, 0),
    socsoEmployee: toNumber(p.socsoEmployee, 0),
    socsoEmployer: toNumber(p.socsoEmployer, 0),
    eisEmployee: toNumber(p.eisEmployee, 0),
    eisEmployer: toNumber(p.eisEmployer, 0),
    pcb: toNumber(p.pcb, 0),
    hrdf: toNumber(p.hrdf, 0),
  }))

  const lines: PreviewJournalLine[] = []
  const pushLine = (
    categoryKey: PayrollXeroAccountKey,
    amount: number,
    description: string,
    trackingOption: string | null,
  ) => {
    lines.push({
      accountLabel: PAYROLL_XERO_ACCOUNT_LABELS[categoryKey],
      categoryKey,
      amount: round2(amount),
      description,
      trackingOption: trackingEnabled ? trackingOption : null,
    })
  }

  // Debits — expense side (per the aggregation mode).
  if (aggregationMode === "PER_EMPLOYEE") {
    for (const r of rows) {
      if (r.proratedPay > 0)
        pushLine(
          "salary",
          r.proratedPay,
          `SALARY - ${r.employeeName}`,
          r.projectName,
        )
      if (r.totalAllowances > 0)
        pushLine(
          "allowance",
          r.totalAllowances,
          `ALLOWANCE - ${r.employeeName}`,
          r.projectName,
        )
      if (r.otPay > 0)
        pushLine(
          // Overtime falls back to the unified allowance account (or
          // salary if no allowance set) until the v2 per-category
          // pipeline is wired in the journal builder.
          "allowance",
          r.otPay,
          `OVERTIME - ${r.employeeName}`,
          r.projectName,
        )
    }
  } else {
    const buckets = new Map<
      string,
      { salary: number; allowance: number; overtime: number }
    >()
    for (const r of rows) {
      const b = buckets.get(r.projectName) ?? {
        salary: 0,
        allowance: 0,
        overtime: 0,
      }
      b.salary += r.proratedPay
      b.allowance += r.totalAllowances
      b.overtime += r.otPay
      buckets.set(r.projectName, b)
    }
    for (const [project, b] of buckets.entries()) {
      if (b.salary > 0)
        pushLine("salary", b.salary, `SALARY - ${project}`, project)
      if (b.allowance > 0)
        pushLine("allowance", b.allowance, `ALLOWANCE - ${project}`, project)
      if (b.overtime > 0)
        pushLine("allowance", b.overtime, `OVERTIME - ${project}`, project)
    }
  }

  // Employer contributions are expense/debit lines, so split them
  // by project like salary. Only accrual credits stay on all projects.
  const contributionBuckets = new Map<
    string,
    { epf: number; socso: number; eis: number; hrdf: number }
  >()
  for (const r of rows) {
    const b = contributionBuckets.get(r.projectName) ?? {
      epf: 0,
      socso: 0,
      eis: 0,
      hrdf: 0,
    }
    b.epf += r.epfEmployer
    b.socso += r.socsoEmployer
    b.eis += r.eisEmployer
    b.hrdf += r.hrdf
    contributionBuckets.set(r.projectName, b)
  }
  for (const [project, b] of contributionBuckets.entries()) {
    if (b.epf > 0)
      pushLine(
        "epfEmployer",
        b.epf,
        `EPF CONTRIBUTION - EMPLOYER - ${project}`,
        project,
      )
    if (b.socso > 0)
      pushLine(
        "socsoEmployer",
        b.socso,
        `SOCSO CONTRIBUTION - EMPLOYER - ${project}`,
        project,
      )
    if (b.eis > 0)
      pushLine(
        "eisEmployer",
        b.eis,
        `EIS CONTRIBUTION - EMPLOYER - ${project}`,
        project,
      )
    if (b.hrdf > 0)
      pushLine("hrdfEmployer", b.hrdf, `HRDF - EMPLOYER - ${project}`, project)
  }

  // Accruals (always summed, credits → negative amounts).
  const totalEpf = sum(rows, (r) => r.epfEmployee + r.epfEmployer)
  const totalSocso = sum(rows, (r) => r.socsoEmployee + r.socsoEmployer)
  const totalEis = sum(rows, (r) => r.eisEmployee + r.eisEmployer)
  const totalPcb = sum(rows, (r) => r.pcb)
  // HRDF employer levy was debited above — credit the payable so the
  // journal balances. Deductions reduced net pay, so they also need a
  // matching credit to their account.
  const totalHrdf = sum(rows, (r) => r.hrdf)
  const totalDeductions = sum(rows, (r) => r.totalDeductions)
  // Reimbursements post as separate Bills during payroll approval — they
  // must NOT appear in the accrual-salary credit or we'd double-
  // count the payable.
  const totalNet = sum(rows, (r) => r.netPay - r.totalReimbursements)
  if (totalEpf > 0)
    pushLine(
      "accrualEpf",
      -totalEpf,
      "ACCRUAL - EPF CONTRIBUTION (Total Employer & Employee)",
      ALL_PROJECTS,
    )
  if (totalSocso > 0)
    pushLine(
      "accrualSocso",
      -totalSocso,
      "ACCRUAL - SOCSO CONTRIBUTION",
      ALL_PROJECTS,
    )
  if (totalEis > 0)
    pushLine(
      "accrualEis",
      -totalEis,
      "ACCRUAL - EIS CONTRIBUTION",
      ALL_PROJECTS,
    )
  if (totalPcb > 0)
    pushLine(
      "accrualPcb",
      -totalPcb,
      "ACCRUAL - PCB DEDUCTION (Employee only)",
      ALL_PROJECTS,
    )
  if (totalDeductions > 0)
    pushLine(
      "deduction",
      -totalDeductions,
      "DEDUCTIONS (Employee)",
      ALL_PROJECTS,
    )
  if (totalHrdf > 0)
    pushLine(
      "accrualHrdf",
      -totalHrdf,
      "ACCRUAL - HRDF (HRD Corp levy payable)",
      ALL_PROJECTS,
    )
  if (totalNet > 0)
    pushLine("accrualSalary", -totalNet, "ACCRUAL - SALARY", ALL_PROJECTS)

  const totalDebits = lines
    .filter((l) => l.amount > 0)
    .reduce((s, l) => s + l.amount, 0)
  const totalCredits = lines
    .filter((l) => l.amount < 0)
    .reduce((s, l) => s + Math.abs(l.amount), 0)
  const isBalanced = Math.abs(totalDebits - totalCredits) <= 0.01

  const periodEnd = new Date(
    Date.UTC(run.periodYear, run.periodMonth, 0),
  )
    .toISOString()
    .slice(0, 10)
  const narration = `${run.periodYear} - SALARY FOR ${monthName(
    run.periodMonth,
  )} ${run.periodYear}`

  const preview: PayrollSyncPreview = {
    bills,
    journal: {
      narration,
      date: periodEnd,
      lines,
      totalDebits: round2(totalDebits),
      totalCredits: round2(totalCredits),
      isBalanced,
    },
    mapping,
    missingAccountKeys,
    missingAllowanceCategories,
    missingDeductionCategories,
    syncEnabled,
    claimsSyncEnabled,
  }

  // Treat per-category gaps the same as missing top-level account
  // keys — the sync will refuse to post if either bucket is non-empty.
  const hasMissingCategories =
    missingAllowanceCategories.length > 0 ||
    missingDeductionCategories.length > 0

  if (!mapping || missingAccountKeys.length > 0 || hasMissingCategories) {
    return {
      status: "skipped",
      message: !mapping
        ? "Xero mapping not configured. Approve will skip the Xero post."
        : missingAccountKeys.length > 0
          ? `Mapping incomplete. Missing accounts: ${missingAccountKeys.join(
              ", ",
            )}.`
          : `Per-category mapping incomplete. Missing categories: ${[
              ...missingAllowanceCategories.map((c) => c.label),
              ...missingDeductionCategories.map((c) => c.label),
            ].join(", ")}.`,
      preview,
    }
  }

  if (!syncEnabled) {
    return {
      status: "skipped",
      message:
        'Payroll → Xero sync is disabled. Enable "Sync payroll to Xero on submit" in Settings.',
      preview,
    }
  }

  return { status: "success", preview }
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}
function sum<T>(arr: T[], fn: (t: T) => number): number {
  return arr.reduce((s, x) => s + fn(x), 0)
}
function monthName(m: number): string {
  const names = [
    "JANUARY",
    "FEBRUARY",
    "MARCH",
    "APRIL",
    "MAY",
    "JUNE",
    "JULY",
    "AUGUST",
    "SEPTEMBER",
    "OCTOBER",
    "NOVEMBER",
    "DECEMBER",
  ]
  return names[m - 1] ?? `MONTH ${m}`
}
