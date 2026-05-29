import "server-only"

import { isAdminRole } from "@/lib/auth/types"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
import { SALARY_CHANGE_REASON_LABELS } from "@/modules/payroll/domain/salary-change"
import {
  computeSalaryChangeHint,
  type SalaryChangeHint,
} from "@/modules/payroll/domain/salary-change-hint"
import { payrollRunAdjustmentRepository } from "@/modules/payroll/infrastructure/payroll-run-adjustment.repository"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"
import { salaryChangeRepository } from "@/modules/payroll/infrastructure/salary-change.repository"

/**
 * Smart-hint service for mid-cycle salary changes.
 *
 * Two entry points:
 *   - `getSalaryChangeHintsForRun(runId)` — read-only, used by the
 *     run-detail page to surface the banners.
 *   - `applySalaryChangeHint(...)` — server action target. Adds the
 *     pre-computed line item to the run's PayrollRunAdjustment, then
 *     busts caches so the payslip totals refresh on next render.
 *
 * Both functions enforce admin session + org scoping so an admin
 * can't poke at another org's salary changes by guessing IDs.
 */

/**
 * Build the list of salary-change hints that apply to a given
 * payroll run. Empty list when:
 *   - no salary changes fall inside the run's period, or
 *   - every change has already had its adjustment applied
 *     (we still return MATCHED / UNKNOWN entries so the UI can
 *     surface them, but the suggestion is null).
 *
 * Returns `null` when the caller doesn't have access (no session,
 * not admin, or the run doesn't belong to the active org).
 */
export async function getSalaryChangeHintsForRun(input: {
  runId: string
}): Promise<SalaryChangeHint[] | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) return null

  const { periodYear, periodMonth } = run

  // Pull the period bounds in ISO yyyy-mm-dd so the date query can be
  // compared against the schema's DateTime column.
  const periodStart = `${periodYear}-${String(periodMonth).padStart(2, "0")}-01`
  const lastDay = new Date(Date.UTC(periodYear, periodMonth, 0)).getUTCDate()
  const periodEnd = `${periodYear}-${String(periodMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`

  // Load:
  //   1. SalaryChange rows whose effectiveDate is inside this period
  //   2. The run's payslips (snapshotMonthlySalary needed)
  //   3. Any existing adjustments (manualLineItems labels needed to
  //      detect already-applied hints)
  //   4. Org settings (workingDaysRule)
  const [changes, payslips, adjustments, settings] = await Promise.all([
    salaryChangeRepository.findInDateRangeForOrg({
      organizationId: orgId,
      fromDate: periodStart,
      toDate: periodEnd,
    }),
    payslipRepository.listForRun(run.id),
    payrollRunAdjustmentRepository.listForRun(run.id),
    payrollSettingsRepository.getByOrgId(orgId),
  ])

  // Index payslips by employeeProfileId for O(1) lookup. Adjustments
  // already come back as a Map keyed by employeeProfileId, so we just
  // flatten the labels for the hint matcher.
  const payslipByEpId = new Map(payslips.map((p) => [p.employeeProfileId, p]))
  const labelsByEpId = new Map<string, string[]>()
  for (const [epId, adj] of adjustments.entries()) {
    labelsByEpId.set(
      epId,
      adj.manualLineItems.map((li) => li.label),
    )
  }

  const prorationRule = settings?.workingDaysRule ?? "CALENDAR"

  const hints: SalaryChangeHint[] = []
  for (const change of changes) {
    const payslip = payslipByEpId.get(change.employeeProfileId)
    // No payslip on this run for the employee → either the change is
    // about a leaver / joiner who's not on the run, or someone the run
    // hasn't generated for yet. Skip — banner can't help if there's no
    // payslip to adjust.
    if (!payslip) continue
    // Only MONTHLY salary changes get pro-rated by this helper.
    if (payslip.snapshotSalaryType !== "MONTHLY") continue

    const hint = computeSalaryChangeHint({
      payslipId: payslip.id,
      employeeProfileId: change.employeeProfileId,
      employeeName: payslip.snapshotName,
      payslipSnapshotMonthlySalary: payslip.snapshotMonthlySalary ?? 0,
      salaryChange: change,
      reasonLabel: SALARY_CHANGE_REASON_LABELS[change.reason],
      periodYear,
      periodMonth,
      prorationRule,
      existingManualLineLabels:
        labelsByEpId.get(change.employeeProfileId) ?? [],
    })
    if (hint) hints.push(hint)
  }
  return hints
}

/**
 * Apply a salary-change hint by appending its suggested line item to
 * the run's `PayrollRunAdjustment.manualLineItems`. Recomputes the
 * hint server-side from the original data so the client can't trick
 * us into adding a hand-edited amount.
 *
 * Idempotent: if the marker already exists in the existing manual
 * lines, the function no-ops + returns the existing adjustment. The
 * UI banner self-hides as well, but this defends against double POSTs
 * (e.g. double-click).
 */
export async function applySalaryChangeHint(input: {
  runId: string
  payslipId: string
  salaryChangeId: string
}): Promise<{ applied: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  // Re-derive every hint for the run from scratch. Cheap (one
  // round-trip's worth of data) and means we don't trust anything
  // from the client beyond the IDs.
  const hints = await getSalaryChangeHintsForRun({ runId: input.runId })
  if (hints == null) throw new Error("Payroll run not found.")

  const hint = hints.find(
    (h) =>
      h.payslipId === input.payslipId &&
      h.salaryChangeId === input.salaryChangeId,
  )
  if (!hint) {
    throw new Error(
      "This salary-change hint is no longer applicable. Refresh the page.",
    )
  }
  if (hint.alreadyApplied) {
    return { applied: false, message: "Adjustment was already applied." }
  }
  if (!hint.suggestedLineItem) {
    throw new Error(
      "No automatic adjustment is available for this scenario — add a manual line item.",
    )
  }

  // Append to whatever's already on the adjustment row. Repo upsert
  // overwrites manualLineItems wholesale, so we have to read first.
  const existing = await payrollRunAdjustmentRepository.getOne({
    payrollRunId: input.runId,
    employeeProfileId: hint.employeeProfileId,
  })

  const nextLines = [
    ...(existing?.manualLineItems ?? []),
    hint.suggestedLineItem,
  ]

  await payrollRunAdjustmentRepository.upsert({
    payrollRunId: input.runId,
    employeeProfileId: hint.employeeProfileId,
    patch: { manualLineItems: nextLines },
  })

  // Bust payroll caches so the run-detail page rehydrates with the
  // new adjustment + updated payslip totals on the next request.
  await bustPayrollCaches({ organizationId: orgId })

  return {
    applied: true,
    message: `Added ${hint.scenario === "OVERPAID" ? "deduction" : "arrears allowance"} of RM ${hint.delta.toFixed(2)} for ${hint.employeeName}.`,
  }
}
