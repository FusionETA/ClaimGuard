import "server-only"

import { createHash } from "node:crypto"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
import { safeErrorMessage } from "@/lib/errors"
import { toNumber } from "@/lib/decimal"
import { getPrismaClient } from "@/lib/prisma"
import { createXeroManualJournal, getXeroTrackingCategories } from "@/lib/xero"
import { getUsableXeroAccessToken } from "@/modules/organization/application/services/xero-connection.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import {
  PAYROLL_XERO_ALLOWANCE_CATEGORIES,
  PAYROLL_XERO_DEDUCTION_CATEGORIES,
  getPayrollAdjustmentLabel,
  type PayrollXeroAccountKey,
  type PayrollXeroMapping,
} from "@/modules/payroll/domain/settings"
import type { PayrollAdjustmentCategory } from "@/modules/payroll/domain/models"

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
  if (!session || session.role !== "ADMIN") {
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
          /**
           * Reimbursements come from claims, which post to Xero as
           * Bills on claim approval. They must NOT appear on the
           * manual journal or we'd double-count: bill creates the
           * payable, accrual-salary would create a second one. We
           * subtract this from `netPay` when computing ACCRUAL
           * SALARY below.
           */
          totalReimbursements: true,
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
          // Line items — needed to drive per-category allowance /
          // deduction mapping under the v2 schema. Each row tags
          // itself with a kind (ALLOWANCE / DEDUCTION / REIMBURSEMENT)
          // and an optional `category` (PayrollAdjustmentCategory).
          // Reimbursements are skipped here — they post as Bills on
          // claim approval, not in this journal.
          lineItems: {
            select: {
              kind: true,
              category: true,
              amount: true,
              label: true,
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

  // Pre-flight: required accounts must all be set.
  const missing = REQUIRED_ACCOUNT_KEYS.filter((k) => !mapping.accounts[k])
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

  // Resolve tracking category Name from the saved ID (Xero's bill /
  // journal API takes the category Name + option Name, not IDs).
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
  const invalidMappedAccounts = REQUIRED_ACCOUNT_KEYS.filter((key) => !codeFor(key))
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
  // builder can iterate each independently — reimbursements come from
  // claims and post as Bills on claim approval, never here.
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
    for (const li of p.lineItems) {
      const amount = toNumber(li.amount, 0)
      if (amount <= 0) continue
      const cat = (li.category as PayrollAdjustmentCategory | null) ?? null
      const entry = { category: cat, amount, label: li.label }
      if (li.kind === "ALLOWANCE") allowanceLines.push(entry)
      else if (li.kind === "DEDUCTION") deductionLines.push(entry)
      // REIMBURSEMENT lines stay on the Bill side — ignored here.
    }
    return {
      id: p.id,
      employeeName: p.snapshotName,
      employeeId: p.snapshotEmployeeId,
      projectName: projectName ?? NO_PROJECT,
      basicPay: toNumber(p.basicPay, 0),
      otPay: toNumber(p.otPay, 0),
      totalReimbursements: toNumber(p.totalReimbursements, 0),
      netPay: toNumber(p.netPay, 0),
      epfEmployee: toNumber(p.epfEmployee, 0),
      epfEmployer: toNumber(p.epfEmployer, 0),
      socsoEmployee: toNumber(p.socsoEmployee, 0),
      socsoEmployer: toNumber(p.socsoEmployer, 0),
      eisEmployee: toNumber(p.eisEmployee, 0),
      eisEmployer: toNumber(p.eisEmployer, 0),
      pcb: toNumber(p.pcb, 0),
      hrdf: toNumber(p.hrdf, 0),
      allowanceLines,
      deductionLines,
    }
  })

  // ── Per-category mapping resolution ──
  // Resolve a category to a Xero account code:
  //   - UNIFIED mode: always return the unified account.
  //   - PER_CATEGORY: look up per-category map; missing = unmapped.
  // `unmappedAllowanceCategories` / `unmappedDeductionCategories`
  // collect categories that appeared on a payslip line but weren't
  // mapped under PER_CATEGORY mode — surfaced in the pre-flight
  // error message so the admin knows exactly which categories to
  // configure before retrying.
  const unmappedAllowanceCategories = new Set<PayrollAdjustmentCategory>()
  const unmappedDeductionCategories = new Set<PayrollAdjustmentCategory>()

  function allowanceCodeForCategory(
    cat: PayrollAdjustmentCategory | null,
  ): string | null {
    if (mapping?.allowanceMode === "PER_CATEGORY") {
      if (!cat) return codeFor("allowance") ?? null // legacy null-cat → fallback
      const id = mapping.allowanceAccounts[cat]
      if (!id) {
        unmappedAllowanceCategories.add(cat)
        return null
      }
      return accountCodeById.get(id) ?? null
    }
    return codeFor("allowance") ?? null
  }
  function deductionCodeForCategory(
    cat: PayrollAdjustmentCategory | null,
  ): string | null {
    if (mapping?.deductionMode === "PER_CATEGORY") {
      if (!cat) return codeFor("deduction") ?? null
      const id = mapping.deductionAccounts[cat]
      if (!id) {
        unmappedDeductionCategories.add(cat)
        return null
      }
      return accountCodeById.get(id) ?? null
    }
    return codeFor("deduction") ?? null
  }

  const salaryCode = codeFor("salary")!

  // Per-employee SALARY debits — basicPay only (allowances + OT now
  // come from line items, not the summed payslip column).
  if (mapping.aggregationMode === "PER_EMPLOYEE") {
    for (const r of rows) {
      if (r.basicPay > 0) {
        lines.push({
          accountCode: salaryCode,
          amount: round2(r.basicPay),
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
    for (const r of rows) {
      salaryBuckets.set(
        r.projectName,
        (salaryBuckets.get(r.projectName) ?? 0) + r.basicPay,
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

  // ── Accrual lines (credit, always summed) ──
  const totalEpf = sum(rows, (r) => r.epfEmployee + r.epfEmployer)
  const totalSocso = sum(rows, (r) => r.socsoEmployee + r.socsoEmployer)
  const totalEis = sum(rows, (r) => r.eisEmployee + r.eisEmployer)
  const totalPcb = sum(rows, (r) => r.pcb)
  // Net excludes reimbursements: those amounts post as separate
  // Xero Bills on claim approval and would double-count if included
  // in the accrual-salary credit. The math: gross + reimbursements
  // − deductions = netPay (current schema), so we subtract
  // reimbursements back out to land on "salary net only".
  const totalNet = sum(rows, (r) => r.netPay - r.totalReimbursements)

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
  if (totalPcb > 0) {
    lines.push({
      accountCode: codeFor("accrualPcb")!,
      amount: -round2(totalPcb),
      description: "ACCRUAL - PCB DEDUCTION (Employee only)",
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
