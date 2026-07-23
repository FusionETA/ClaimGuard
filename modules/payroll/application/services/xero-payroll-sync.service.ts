import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { createHash } from "node:crypto"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
import { safeErrorMessage } from "@/lib/errors"
import { toNumber } from "@/lib/decimal"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { createXeroManualJournal, getXeroTrackingCategories } from "@/lib/xero"
import { getUsableXeroAccessToken } from "@/modules/organization/application/services/xero-connection.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import {
  PAYROLL_XERO_ALLOWANCE_CATEGORIES,
  PAYROLL_XERO_DEDUCTION_CATEGORIES,
  getPayrollAdjustmentLabel,
  type PayrollXeroAccountKey,
  type PayrollXeroMapping,
} from "@/modules/payroll/domain/settings"
import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"

/**
 * Builds and posts a Xero Manual Journal that mirrors the payroll
 * run's totals. Fires when an admin approves a payroll run (status
 * flip PENDING_APPROVAL → SUBMITTED).
 *
 * Journal shape per the agreed design (see memory/xero_sync_design.md):
 *
 *   DEBITS (expense side):
 *     • SALARY line per employee — basic pay
 *     • ALLOWANCE line per employee — sum of allowance line items
 *     • OVERTIME line per employee (when otPay > 0) — falls back to
 *       SALARY account if `overtime` COA isn't set
 *     • EPF EMPLOYER (single summed line)
 *     • SOCSO EMPLOYER (single summed line)
 *     • EIS EMPLOYER (single summed line)
 *     • HRDF EMPLOYER (single summed line, when present)
 *
 *   CREDITS (accruals — ALWAYS summed regardless of aggregation):
 *     • ACCRUAL EPF (employee + employer halves)
 *     • ACCRUAL SOCSO (employee + employer)
 *     • ACCRUAL EIS (employee + employer)
 *     • ACCRUAL PCB (employee tax)
 *     • ACCRUAL SALARY (net payable)
 *
 * Aggregation:
 *   - `PER_EMPLOYEE` → one SALARY/ALLOWANCE/OVERTIME line per employee.
 *   - `SUM_BY_PROJECT` → one SALARY/ALLOWANCE/OVERTIME line per
 *     (project, category). Employees with no project assignment
 *     bucket under "(No project)".
 *
 * Tracking category: every line is stamped with the project name on
 * the configured tracking category. Aggregated employer / accrual
 * lines are stamped with "(All projects)" so admins can filter their
 * P&L cleanly.
 */
export type PayrollXeroSyncResult =
  | {
      status: "synced"
      manualJournalId: string
      narration: string
    }
  | { status: "skipped"; message: string }
  | { status: "error"; message: string }

/**
 * Required accounts before we'll fire a sync. Optional extras
 * (bonus / commission / overtime) fall back to the salary account.
 */
const REQUIRED_ACCOUNT_KEYS: PayrollXeroAccountKey[] = [
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

export async function syncPayrollRunToXero(
  payrollRunId: string,
): Promise<PayrollXeroSyncResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { status: "error", message: "No active organisation." }

  const prisma = getPrismaClient()
  if (!prisma) return { status: "error", message: "Database is not configured." }

  // Pull the run with everything we need for the journal.
  const run = await prisma.payrollRun.findFirst({
    where: { id: payrollRunId, organizationId: orgId },
    select: {
      id: true,
      periodYear: true,
      periodMonth: true,
      status: true,
      xeroManualJournalId: true,
      payslips: {
        select: {
          id: true,
          snapshotName: true,
          snapshotEmployeeId: true,
          basicPay: true,
          proratedPay: true,
          otPay: true,
          totalAllowances: true,
          // Reimbursements are paid through payroll. They are posted
          // in this manual journal as claim-expense debits, while the
          // reimbursement-inclusive net pay is credited to salary
          // payable below.
          totalReimbursements: true,
          grossPay: true,
          netPay: true,
          epfEmployee: true,
          epfEmployer: true,
          socsoEmployee: true,
          socsoEmployer: true,
          eisEmployee: true,
          eisEmployer: true,
          /// SKBBK (Skim LINDUNG 24 Jam) — employee-only PERKESO
          /// scheme effective Jun 2026. Reduces net pay (see calc.ts)
          /// and is credited to its own accrual so the journal
          /// balances. Without this the sync silently drops the SKBBK
          /// amount and Xero rejects the manual journal.
          skbbkEmployee: true,
          pcb: true,
          hrdf: true,
          // Line items — needed to drive per-category allowance /
          // deduction mapping under the v2 schema. Each row tags
          // itself with a kind (ALLOWANCE / DEDUCTION / REIMBURSEMENT)
          // and an optional `category` (PayrollAdjustmentCategory).
          // `claimId` links REIMBURSEMENT lines back to their claim so
          // the journal can debit the claim's expense account.
          lineItems: {
            select: {
              kind: true,
              category: true,
              amount: true,
              label: true,
              claimId: true,
            },
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
    },
  })

  if (!run) return { status: "error", message: "Payroll run not found." }
  if (run.xeroManualJournalId) {
    return {
      status: "skipped",
      message: "This payroll run is already synced to Xero.",
    }
  }
  if (run.payslips.length === 0) {
    return {
      status: "skipped",
      message: "Payroll run has no payslips to post.",
    }
  }

  const settings = await payrollSettingsRepository.getByOrgId(orgId)
  const mapping = settings?.xeroMapping
  if (!mapping) {
    return {
      status: "error",
      message:
        "No Xero mapping configured. Set it up in Payroll Settings → Xero sync.",
    }
  }

  // Pre-flight: required accounts must all be set. HRDF is an
  // employer-only levy that not every org pays, so its two accounts
  // (employer expense + accrual payable) are only required when at
  // least one payslip in this run actually carries an HRDF charge.
  const runHasHrdf = run.payslips.some((p) => toNumber(p.hrdf, 0) > 0)
  // SKBBK is opt-in per-employee — an org can have SUBMITTED payslips
  // with zero SKBBK across the board. Only require the accrual account
  // when the run actually carries a SKBBK charge, mirroring how HRDF
  // is gated above.
  const runHasSkbbk = run.payslips.some(
    (p) => toNumber(p.skbbkEmployee, 0) > 0,
  )
  // Deductions are credited to the unified `deduction` account unless
  // the org runs per-category deduction mapping (in which case the
  // per-category pre-flight below validates coverage instead).
  // Unpaid leave is netted into the SALARY Dr line (no separate
  // deduction line), so it doesn't trigger the unified-deduction
  // account requirement. Only non-unpaid-leave deductions count here.
  const runHasDeductions = run.payslips.some((p) =>
    p.lineItems.some(
      (li) =>
        li.kind === "DEDUCTION" &&
        li.category !== "deduct_unpaid_leave" &&
        toNumber(li.amount, 0) > 0,
    ),
  )
  const requiredKeys: PayrollXeroAccountKey[] = [...REQUIRED_ACCOUNT_KEYS]
  if (runHasHrdf) requiredKeys.push("hrdfEmployer", "accrualHrdf")
  if (runHasSkbbk) requiredKeys.push("accrualSkbbk")
  if (runHasDeductions && mapping.deductionMode !== "PER_CATEGORY") {
    requiredKeys.push("deduction")
  }
  const missing = requiredKeys.filter((k) => !mapping.accounts[k])
  if (missing.length > 0) {
    return {
      status: "error",
      message: `Xero mapping incomplete. Missing accounts: ${missing.join(", ")}.`,
    }
  }

  // Resolve the active Xero connection for this org.
  const connections = await organizationRepository.getXeroConnections(orgId)
  const conn = connections[0]
  if (!conn) {
    return {
      status: "error",
      message: "No active Xero connection for this organisation.",
    }
  }
  const token = await getUsableXeroAccessToken(conn.id)
  if (!token) {
    return {
      status: "error",
      message: "Xero token expired. Reconnect Xero in Settings → Integrations.",
    }
  }

  // Resolve tracking category Name from the saved ID (Xero's journal
  // API takes the category Name + option Name, not IDs).
  let trackingCategoryName: string | null = null
  let trackingOptions: Set<string> | null = null
  if (mapping.trackingCategoryId) {
    try {
      const cats = await getXeroTrackingCategories({
        accessToken: token.accessToken,
        tenantId: token.tenantId,
      })
      const cat = cats.find(
        (c) => c.xeroTrackingCategoryId === mapping.trackingCategoryId,
      )
      if (cat) {
        trackingCategoryName = cat.name
        trackingOptions = new Set(cat.options.map((option) => option.name))
      }
    } catch (err) {
      // Tracking is non-fatal — log and proceed without it.
      console.warn("[xero-payroll-sync] tracking lookup failed:", err)
    }
  }

  // Map account code lookups need the Xero code, not the AccountID,
  // because manual journal lines accept AccountCode (not AccountID).
  // Fetch the accounts once + build an ID → code lookup so we can
  // turn the saved AccountIDs in the mapping into AccountCodes.
  let accountCodeById: Map<string, string>
  try {
    const { getXeroAccounts } = await import("@/lib/xero")
    const accounts = await getXeroAccounts({
      accessToken: token.accessToken,
      tenantId: token.tenantId,
      includeTypes: ["EXPENSE", "LIABILITY", "CURRLIAB", "TERMLIAB"],
    })
    accountCodeById = new Map(accounts.map((a) => [a.xeroAccountId, a.code]))
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not load Xero accounts."),
    }
  }

  function codeFor(key: PayrollXeroAccountKey): string | null {
    const id = mapping?.accounts?.[key] ?? null
    if (!id) return null
    return accountCodeById.get(id) ?? null
  }
  function codeForWithFallback(
    key: PayrollXeroAccountKey,
    fallback: PayrollXeroAccountKey,
  ): string | null {
    return codeFor(key) ?? codeFor(fallback)
  }
  const invalidMappedAccounts = requiredKeys.filter((key) => !codeFor(key))
  if (invalidMappedAccounts.length > 0) {
    return {
      status: "error",
      message:
        "Xero mapping contains accounts that cannot be used in manual journals. " +
        `Please remap: ${invalidMappedAccounts.join(", ")}.`,
    }
  }

  // ── Build the journal lines ──────────────────────────────────────────

  type Line = {
    accountCode: string
    /// Positive = debit, negative = credit.
    amount: number
    description: string
    tracking?: Array<{ name: string; option: string }>
  }
  const lines: Line[] = []
  const ALL_PROJECTS = "(All projects)"
  const NO_PROJECT = "(No project)"

  function track(option: string): Array<{ name: string; option: string }> | undefined {
    if (!trackingCategoryName) return undefined
    if (!trackingOptions?.has(option)) return undefined
    return [{ name: trackingCategoryName, option }]
  }

  // Normalised payslip rows with project + line-item lookup once.
  // Line items are split into allowance vs deduction buckets so the
  // builder can iterate each independently. Reimbursements stay here:
  // payroll pays them out, so the Manual Journal carries the claim
  // expense debit and the matching salary-payable credit.
  const rows = run.payslips.map((p) => {
    const projectName =
      p.employeeProfile?.projectAssignments[0]?.project?.name ?? null
    const allowanceLines: Array<{
      category: PayrollAdjustmentCategory | null
      amount: number
      label: string
    }> = []
    const deductionLines: Array<{
      category: PayrollAdjustmentCategory | null
      amount: number
      label: string
    }> = []
    // Reimbursements (approved claims attached to this run). Each posts
    // as a DEBIT to the claim's own expense account; the matching CREDIT
    // rides on the (now reimbursement-inclusive) ACCRUAL SALARY line.
    const reimbursementLines: Array<{
      claimId: string
      amount: number
      label: string
    }> = []
    for (const li of p.lineItems) {
      const amount = toNumber(li.amount, 0)
      if (amount <= 0) continue
      const cat = (li.category as PayrollAdjustmentCategory | null) ?? null
      const entry = { category: cat, amount, label: li.label }
      if (li.kind === "REIMBURSEMENT") {
        if (li.claimId) {
          reimbursementLines.push({ claimId: li.claimId, amount, label: li.label })
        }
        continue
      }
      if (li.kind === "ALLOWANCE") {
        // BIK / perquisite (non-cash) line items are debited under
        // kind ALLOWANCE by the calc engine, but they NEVER hit gross
        // or net pay — the employee receives no cash, and the real
        // cost is booked elsewhere (rent, car lease, etc.). Including
        // them here would put a debit on the journal with no matching
        // credit and unbalance it. Skip them entirely.
        const isNonCash = cat
          ? PAYROLL_ADJUSTMENT_CATEGORY_META[cat]?.nonCash === true
          : false
        if (!isNonCash) allowanceLines.push(entry)
      } else if (li.kind === "DEDUCTION") {
        deductionLines.push(entry)
      }
    }
    return {
      id: p.id,
      employeeName: p.snapshotName,
      employeeId: p.snapshotEmployeeId,
      projectName: projectName ?? NO_PROJECT,
      reimbursementLines,
      // Use proratedPay (basicPay × proration), NOT basicPay — the
      // payroll engine's gross is built on proratedPay, so an
      // employee with unpaid leave / mid-month join would otherwise
      // leave the journal off by (basicPay − proratedPay).
      proratedPay: toNumber(p.proratedPay, 0),
      otPay: toNumber(p.otPay, 0),
      totalReimbursements: toNumber(p.totalReimbursements, 0),
      netPay: toNumber(p.netPay, 0),
      epfEmployee: toNumber(p.epfEmployee, 0),
      epfEmployer: toNumber(p.epfEmployer, 0),
      socsoEmployee: toNumber(p.socsoEmployee, 0),
      socsoEmployer: toNumber(p.socsoEmployer, 0),
      eisEmployee: toNumber(p.eisEmployee, 0),
      eisEmployer: toNumber(p.eisEmployer, 0),
      skbbkEmployee: toNumber(p.skbbkEmployee, 0),
      pcb: toNumber(p.pcb, 0),
      hrdf: toNumber(p.hrdf, 0),
      allowanceLines,
      deductionLines,
    }
  })

  // ── Per-category mapping resolution ──
  // Resolve a category to a Xero account code:
  //   - Per-category override (if set on the mapping) WINS regardless
  //     of mode. This lets admins stay on UNIFIED mode but pin a
  //     dedicated COA for a single category (e.g. OT, unutilized leave
  //     pay) without forcing every category into PER_CATEGORY.
  //   - PER_CATEGORY mode with no override → category is unmapped
  //     (collected into the pre-flight error set below).
  //   - UNIFIED mode with no override → unified account.
  const unmappedAllowanceCategories = new Set<PayrollAdjustmentCategory>()
  const unmappedDeductionCategories = new Set<PayrollAdjustmentCategory>()

  function allowanceCodeForCategory(
    cat: PayrollAdjustmentCategory | null,
  ): string | null {
    if (cat) {
      const id = mapping?.allowanceAccounts?.[cat]
      if (id) {
        const code = accountCodeById.get(id)
        if (code) return code
      }
    }
    if (mapping?.allowanceMode === "PER_CATEGORY") {
      if (!cat) return codeFor("allowance") ?? null // legacy null-cat → fallback
      unmappedAllowanceCategories.add(cat)
      return null
    }
    return codeFor("allowance") ?? null
  }
  function deductionCodeForCategory(
    cat: PayrollAdjustmentCategory | null,
  ): string | null {
    if (cat) {
      const id = mapping?.deductionAccounts?.[cat]
      if (id) {
        const code = accountCodeById.get(id)
        if (code) return code
      }
    }
    if (mapping?.deductionMode === "PER_CATEGORY") {
      if (!cat) return codeFor("deduction") ?? null
      unmappedDeductionCategories.add(cat)
      return null
    }
    return codeFor("deduction") ?? null
  }

  const salaryCode = codeFor("salary")!

  // Per-employee SALARY debits — basicPay only (allowances + OT now
  // come from line items, not the summed payslip column).
  // Unpaid leave is netted directly into the SALARY Dr line (one
  // salary expense line, net of unpaid days — standard payroll
  // software treatment). The matching credit-side line is suppressed
  // below so the journal stays balanced.
  function unpaidLeaveAmtFor(r: (typeof rows)[number]): number {
    return r.deductionLines
      .filter((li) => li.category === "deduct_unpaid_leave")
      .reduce((s, li) => s + li.amount, 0)
  }
  if (mapping.aggregationMode === "PER_EMPLOYEE") {
    for (const r of rows) {
      const unpaidLeaveAmt = unpaidLeaveAmtFor(r)
      const salaryDr = Math.max(0, r.proratedPay - unpaidLeaveAmt)
      if (salaryDr > 0) {
        lines.push({
          accountCode: salaryCode,
          amount: round2(salaryDr),
          description: `SALARY - ${r.employeeName}`,
          tracking: track(r.projectName),
        })
      }
      // OT pay is tracked separately from the line-item bucket
      // because the payroll engine writes it as `otPay`, not as
      // an allowance line item. We still want it as an allowance
      // line on the journal — resolve via the `wages_overtime`
      // category (which falls back to the unified allowance
      // account in UNIFIED mode).
      if (r.otPay > 0) {
        const code = allowanceCodeForCategory("wages_overtime")
        if (code) {
          lines.push({
            accountCode: code,
            amount: round2(r.otPay),
            description: `OVERTIME - ${r.employeeName}`,
            tracking: track(r.projectName),
          })
        }
      }
      // Per-category allowance lines from PayslipLineItem rows.
      for (const li of r.allowanceLines) {
        const code = allowanceCodeForCategory(li.category)
        if (!code) continue // collected into unmappedAllowanceCategories
        const catLabel = li.category
          ? getPayrollAdjustmentLabel(li.category).toUpperCase()
          : "ALLOWANCE"
        lines.push({
          accountCode: code,
          amount: round2(li.amount),
          description: `${catLabel} - ${r.employeeName}${
            li.label ? ` (${li.label})` : ""
          }`,
          tracking: track(r.projectName),
        })
      }
      // Per-category deduction lines (CREDIT). Net pay was already
      // reduced by these, so without a matching credit the journal
      // can't balance (debits would exceed credits by the deduction
      // total). Emit a negative line to the mapped deduction account.
      // `deduct_unpaid_leave` is intentionally skipped — it was netted
      // into the SALARY Dr above, so emitting a credit would double-
      // count and unbalance the journal.
      for (const li of r.deductionLines) {
        if (li.category === "deduct_unpaid_leave") continue
        const code = deductionCodeForCategory(li.category)
        if (!code) continue // collected into unmappedDeductionCategories
        const catLabel = li.category
          ? getPayrollAdjustmentLabel(li.category).toUpperCase()
          : "DEDUCTION"
        lines.push({
          accountCode: code,
          amount: -round2(li.amount),
          description: `${catLabel} - ${r.employeeName}${
            li.label ? ` (${li.label})` : ""
          }`,
          tracking: track(r.projectName),
        })
      }
    }
  } else {
    // ── Sum-by-project: bucket basicPay, OT, and each allowance
    // category by (project, account). Same per-category mapping
    // applies; we just collapse the per-employee dimension.
    const salaryBuckets = new Map<string, number>()
    const otBuckets = new Map<string, number>()
    const allowanceBuckets = new Map<
      string,
      Map<PayrollAdjustmentCategory | "null", number>
    >()
    const deductionBuckets = new Map<
      string,
      Map<PayrollAdjustmentCategory | "null", number>
    >()
    for (const r of rows) {
      const unpaidLeaveAmt = unpaidLeaveAmtFor(r)
      // SALARY bucket is net of unpaid leave (same treatment as the
      // PER_EMPLOYEE branch — one expense line, net of unpaid days).
      salaryBuckets.set(
        r.projectName,
        (salaryBuckets.get(r.projectName) ?? 0) +
          Math.max(0, r.proratedPay - unpaidLeaveAmt),
      )
      otBuckets.set(
        r.projectName,
        (otBuckets.get(r.projectName) ?? 0) + r.otPay,
      )
      const byCat =
        allowanceBuckets.get(r.projectName) ??
        new Map<PayrollAdjustmentCategory | "null", number>()
      for (const li of r.allowanceLines) {
        const k = li.category ?? "null"
        byCat.set(k, (byCat.get(k) ?? 0) + li.amount)
      }
      allowanceBuckets.set(r.projectName, byCat)
      const byDedCat =
        deductionBuckets.get(r.projectName) ??
        new Map<PayrollAdjustmentCategory | "null", number>()
      for (const li of r.deductionLines) {
        // Unpaid leave is netted into SALARY above — don't bucket it
        // here or it would emit a credit and double-count.
        if (li.category === "deduct_unpaid_leave") continue
        const k = li.category ?? "null"
        byDedCat.set(k, (byDedCat.get(k) ?? 0) + li.amount)
      }
      deductionBuckets.set(r.projectName, byDedCat)
    }
    for (const [project, total] of salaryBuckets.entries()) {
      if (total > 0) {
        lines.push({
          accountCode: salaryCode,
          amount: round2(total),
          description: `SALARY - ${project}`,
          tracking: track(project),
        })
      }
    }
    for (const [project, total] of otBuckets.entries()) {
      if (total > 0) {
        const code = allowanceCodeForCategory("wages_overtime")
        if (code) {
          lines.push({
            accountCode: code,
            amount: round2(total),
            description: `OVERTIME - ${project}`,
            tracking: track(project),
          })
        }
      }
    }
    for (const [project, byCat] of allowanceBuckets.entries()) {
      for (const [k, total] of byCat.entries()) {
        const cat = k === "null" ? null : (k as PayrollAdjustmentCategory)
        const code = allowanceCodeForCategory(cat)
        if (!code) continue
        const catLabel = cat
          ? getPayrollAdjustmentLabel(cat).toUpperCase()
          : "ALLOWANCE"
        lines.push({
          accountCode: code,
          amount: round2(total),
          description: `${catLabel} - ${project}`,
          tracking: track(project),
        })
      }
    }
    // Deduction credits, bucketed the same way as allowances.
    for (const [project, byCat] of deductionBuckets.entries()) {
      for (const [k, total] of byCat.entries()) {
        const cat = k === "null" ? null : (k as PayrollAdjustmentCategory)
        const code = deductionCodeForCategory(cat)
        if (!code) continue
        const catLabel = cat
          ? getPayrollAdjustmentLabel(cat).toUpperCase()
          : "DEDUCTION"
        lines.push({
          accountCode: code,
          amount: -round2(total),
          description: `${catLabel} - ${project}`,
          tracking: track(project),
        })
      }
    }
  }

  // ── Pre-flight: any categories present on the run but not mapped?
  // (Only fires for PER_CATEGORY modes, since UNIFIED uses a single
  // fallback account that's already pre-flighted in REQUIRED_ACCOUNT_KEYS.)
  // We push these checks BEFORE the credit lines emit deductions —
  // and BEFORE the actual Xero post — so admins see exactly what
  // categories to map.
  if (
    unmappedAllowanceCategories.size > 0 ||
    unmappedDeductionCategories.size > 0
  ) {
    const a = Array.from(unmappedAllowanceCategories)
      .map((c) => getPayrollAdjustmentLabel(c))
      .join(", ")
    const d = Array.from(unmappedDeductionCategories)
      .map((c) => getPayrollAdjustmentLabel(c))
      .join(", ")
    const parts: string[] = []
    if (a) parts.push(`Allowance categories missing an account: ${a}`)
    if (d) parts.push(`Deduction categories missing an account: ${d}`)
    return {
      status: "error",
      message: `${parts.join(". ")}. Map them in Payroll Settings → Xero sync, then retry.`,
    }
  }

  // ── Employer contributions (expense/debit side) ──
  // These are expenses, so split them by project like salary lines.
  // Only accrual credits below stay summed under "(All projects)".
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
  const hrdfCode = codeFor("hrdfEmployer")
  for (const [project, b] of contributionBuckets.entries()) {
    if (b.epf > 0) {
      lines.push({
        accountCode: codeFor("epfEmployer")!,
        amount: round2(b.epf),
        description: `EPF CONTRIBUTION - EMPLOYER - ${project}`,
        tracking: track(project),
      })
    }
    if (b.socso > 0) {
      lines.push({
        accountCode: codeFor("socsoEmployer")!,
        amount: round2(b.socso),
        description: `SOCSO CONTRIBUTION - EMPLOYER - ${project}`,
        tracking: track(project),
      })
    }
    if (b.eis > 0) {
      lines.push({
        accountCode: codeFor("eisEmployer")!,
        amount: round2(b.eis),
        description: `EIS CONTRIBUTION - EMPLOYER - ${project}`,
        tracking: track(project),
      })
    }
    if (hrdfCode && b.hrdf > 0) {
      lines.push({
        accountCode: hrdfCode,
        amount: round2(b.hrdf),
        description: `HRDF - EMPLOYER - ${project}`,
        tracking: track(project),
      })
    }
  }

  // ── Reimbursement debits (approved claims included in this payroll) ──
  // Each reimbursement debits the claim's own expense account; the
  // matching credit is folded into the ACCRUAL SALARY line below (which
  // now includes reimbursements). Grouped by (expense code, project) so
  // the journal stays compact. Claims whose expense account has no Xero
  // code are skipped — they can't be journalled, so they'd leave the
  // run's net payable unbalanced; surfaced as a pre-flight error.
  const allReimbursementClaimIds = rows.flatMap((r) =>
    r.reimbursementLines.map((l) => l.claimId),
  )
  const reimbursementJournalData =
    allReimbursementClaimIds.length > 0
      ? await claimRepository.getReimbursementJournalDataForClaims(
          allReimbursementClaimIds,
        )
      : new Map<
          string,
          {
            accountCode: string | null
            accountName: string | null
            projectName: string | null
          }
        >()

  const unmappedReimbursementClaims: string[] = []
  // Bucket by (expense account code, project) → summed amount.
  const reimbursementBuckets = new Map<
    string,
    { code: string; project: string; amount: number }
  >()
  for (const r of rows) {
    for (const rl of r.reimbursementLines) {
      const meta = reimbursementJournalData.get(rl.claimId)
      const code = meta?.accountCode ?? null
      if (!code) {
        unmappedReimbursementClaims.push(rl.label || rl.claimId)
        continue
      }
      const project = meta?.projectName ?? r.projectName
      const bucketKey = `${code}::${project}`
      const existing = reimbursementBuckets.get(bucketKey)
      if (existing) {
        existing.amount = round2(existing.amount + rl.amount)
      } else {
        reimbursementBuckets.set(bucketKey, {
          code,
          project,
          amount: round2(rl.amount),
        })
      }
    }
  }

  // If any attached claim can't resolve a Xero expense code, refuse to
  // post — otherwise the net-payable credit (which includes the
  // reimbursement) would have no matching debit and the journal would
  // not balance.
  if (unmappedReimbursementClaims.length > 0) {
    return {
      status: "error",
      message:
        "These reimbursement claims have no Xero-linked expense account, so they can't be posted to the manual journal: " +
        unmappedReimbursementClaims.join(", ") +
        ". Fix the claim's expense account before retrying.",
    }
  }

  for (const bucket of reimbursementBuckets.values()) {
    lines.push({
      accountCode: bucket.code,
      amount: round2(bucket.amount),
      description: `REIMBURSEMENT - ${bucket.project}`,
      tracking: track(bucket.project),
    })
  }

  // ── Accrual lines (credit, always summed) ──
  const totalEpf = sum(rows, (r) => r.epfEmployee + r.epfEmployer)
  const totalSocso = sum(rows, (r) => r.socsoEmployee + r.socsoEmployer)
  const totalEis = sum(rows, (r) => r.eisEmployee + r.eisEmployer)
  const totalSkbbk = sum(rows, (r) => r.skbbkEmployee)
  const totalPcb = sum(rows, (r) => r.pcb)
  // HRDF is an employer-only levy. It's debited as an expense in the
  // employer-contributions block above, so it needs a matching credit
  // here (the payable owed to HRD Corp), or the journal won't balance.
  const totalHrdf = sum(rows, (r) => r.hrdf)
  // Net INCLUDES reimbursements: attached claims are paid out as part of
  // payroll (not as separate bills), so the net payable the company owes
  // employees covers salary + reimbursement. The matching debits are the
  // REIMBURSEMENT expense lines emitted above, so the journal balances.
  const totalNet = sum(rows, (r) => r.netPay)

  if (totalEpf > 0) {
    lines.push({
      accountCode: codeFor("accrualEpf")!,
      amount: -round2(totalEpf),
      description: "ACCRUAL - EPF CONTRIBUTION (Total Employer & Employee)",
      tracking: track(ALL_PROJECTS),
    })
  }
  if (totalSocso > 0) {
    lines.push({
      accountCode: codeFor("accrualSocso")!,
      amount: -round2(totalSocso),
      description: "ACCRUAL - SOCSO CONTRIBUTION",
      tracking: track(ALL_PROJECTS),
    })
  }
  if (totalEis > 0) {
    lines.push({
      accountCode: codeFor("accrualEis")!,
      amount: -round2(totalEis),
      description: "ACCRUAL - EIS CONTRIBUTION",
      tracking: track(ALL_PROJECTS),
    })
  }
  if (totalSkbbk > 0) {
    lines.push({
      accountCode: codeFor("accrualSkbbk")!,
      amount: -round2(totalSkbbk),
      description: "ACCRUAL - SKBBK (Skim LINDUNG 24 Jam, Employee only)",
      tracking: track(ALL_PROJECTS),
    })
  }
  if (totalPcb > 0) {
    lines.push({
      accountCode: codeFor("accrualPcb")!,
      amount: -round2(totalPcb),
      description: "ACCRUAL - PCB DEDUCTION (Employee only)",
      tracking: track(ALL_PROJECTS),
    })
  }
  if (totalHrdf > 0) {
    lines.push({
      accountCode: codeFor("accrualHrdf")!,
      amount: -round2(totalHrdf),
      description: "ACCRUAL - HRDF (HRD Corp levy payable)",
      tracking: track(ALL_PROJECTS),
    })
  }
  if (totalNet > 0) {
    lines.push({
      accountCode: codeFor("accrualSalary")!,
      amount: -round2(totalNet),
      description: "ACCRUAL - SALARY",
      tracking: track(ALL_PROJECTS),
    })
  }

  // Sanity check: debits + credits should sum to ~zero (rounding may
  // leave a few cents). If they don't, refuse to post — admin needs
  // to recheck calc.
  const balance = lines.reduce((sum, l) => sum + l.amount, 0)
  if (Math.abs(balance) > 0.01) {
    return {
      status: "error",
      message: `Manual journal does not balance (off by ${balance.toFixed(
        2,
      )}). Refusing to post — please re-generate the payroll run.`,
    }
  }

  // ── Post to Xero ──
  try {
    const lastDayOfPeriod = new Date(
      Date.UTC(run.periodYear, run.periodMonth, 0), // day 0 of next month = last day of current
    )
    const dateStr = lastDayOfPeriod.toISOString().slice(0, 10)
    const narration = `${run.periodYear} - SALARY FOR ${monthName(
      run.periodMonth,
    )} ${run.periodYear}`
    const payload = {
      narration,
      date: dateStr,
      lines: lines.map((l) => ({
        accountCode: l.accountCode,
        amount: l.amount,
        description: l.description,
        tracking: l.tracking,
      })),
    }
    const payloadHash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
      .slice(0, 12)

    const result = await createXeroManualJournal({
      accessToken: token.accessToken,
      tenantId: token.tenantId,
      idempotencyKey: `payroll-run-${run.id}-${payloadHash}`,
      payload,
    })

    // Persist the journal IDs so we never double-post.
    await prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        xeroManualJournalId: result.manualJournalId,
        xeroJournalNumber: result.narration,
        xeroSyncStatus: "SYNCED",
        xeroSyncedAt: new Date(),
        xeroSyncError: null,
      },
    })

    // Bust the payroll caches so the run detail page re-renders with the
    // fresh xeroSyncStatus / journal number on the next visit.
    await bustPayrollCaches({ organizationId: orgId })

    return {
      status: "synced",
      manualJournalId: result.manualJournalId,
      narration: result.narration,
    }
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message.trim() : ""
    const message =
      rawMessage.startsWith("Xero manual journal") ||
      rawMessage.startsWith("Xero rejected")
        ? rawMessage
        : safeErrorMessage(err, "Xero manual journal post failed.")
    // Mark the run as FAILED so admin can retry.
    await prisma.payrollRun
      .update({
        where: { id: run.id },
        data: {
          xeroSyncStatus: "ERROR",
          xeroSyncError: message.slice(0, 1000),
        },
      })
      .catch(() => {
        /* best-effort */
      })
    // Bust caches so the run page surfaces the new ERROR status + retry
    // button on the next visit, even if it was sitting in cache as
    // "NOT_SYNCED" before.
    await bustPayrollCaches({ organizationId: orgId })
    return { status: "error", message }
  }
}

function round2(n: number): number {
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
