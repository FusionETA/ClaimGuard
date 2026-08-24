import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { loadStatutoryRunPayload } from "@/modules/payroll/application/services/report-renderers/shared"
import { isMalaysianNationality } from "@/modules/payroll/domain/calc"
import { PAYROLL_REQUIRED_COMPANY_INFO_FIELDS } from "@/modules/payroll/domain/settings"

/**
 * Pre-submit readiness check for a payroll run.
 *
 * Before letting the admin submit a draft for approval, verify the
 * fields each statutory document generator requires are filled in —
 * both at the organisation level (Company Info) and per included
 * employee. If anything is missing we BLOCK the submit and surface a
 * structured list of issues so the UI can render a banner with
 * actionable links instead of failing later at file-generation time
 * with a cryptic error.
 *
 * Required ORG fields (block submit):
 *   - employerName             — every document
 *   - employerTin (LHDN E No.) — PCB TXT, EPF CSV, CP8D, EA
 *   - registrationNo (SSM)     — SOCSO+EIS TXT, CP8D
 *   - perkesoEmployerCode      — SOCSO+EIS TXT
 *
 * NOT required (optional — only fails at PB ECP generation time):
 *   - ecpPayorAccountNo
 *
 * Required PER-EMPLOYEE fields (block submit):
 *   - employeeCode             — PCB TXT
 *   - idNumber                 — PCB TXT + SOCSO+EIS TXT
 *                                (label depends on Malaysian/foreigner)
 *
 * NOT required (intentionally — admins fill these in later before they
 * actually generate the file LHDN needs them for, and missing them
 * shouldn't block the monthly payroll run):
 *   - incomeTaxNumber          — PCB calc runs without a TIN. The TIN
 *                                only matters when generating the CP39
 *                                / PCB TXT for LHDN; admins can patch
 *                                it in then.
 */

export type RunReadinessOrgField =
  | "employerName"
  | "employerTin"
  | "registrationNo"
  | "perkesoEmployerCode"

export type RunReadinessOrgIssue = {
  field: RunReadinessOrgField
  label: string
}

export type RunReadinessEmployeeIssue = {
  employeeCode: string
  name: string
  /// Short field labels e.g. "Income tax number", "New IC number".
  missing: string[]
}

export type RunReadiness = {
  ok: boolean
  orgIssues: RunReadinessOrgIssue[]
  employeeIssues: RunReadinessEmployeeIssue[]
  /// Total count for the run-detail banner (sums org + employees).
  totalMissingCount: number
}

// Source of truth lives in `modules/payroll/domain/settings.ts` so the
// settings UI tab pill checks the SAME list this service blocks on.
const ORG_FIELDS: ReadonlyArray<{ key: RunReadinessOrgField; label: string }> =
  PAYROLL_REQUIRED_COMPANY_INFO_FIELDS

function isBlank(v: string | null | undefined): boolean {
  return !v || v.trim().length === 0
}

/**
 * Compute readiness for a payroll run. Returns null when the session
 * isn't authorised or the run isn't visible — the caller treats that
 * as "no data" rather than "ready".
 */
export async function getPayrollRunReadiness(input: {
  runId: string
}): Promise<RunReadiness | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null
  return computePayrollRunReadiness({
    runId: input.runId,
    organizationId: orgId,
  })
}

/**
 * The readiness computation itself, with the organisation supplied
 * rather than resolved from an admin session.
 *
 * Split out so `GET /api/v1/payroll-runs/[id]/readiness` can reuse it.
 * An API token has no iron-session, so the entry point above returns
 * null for one — and its contract says null means "no data", which a
 * caller would read as "nothing to report" rather than "not checked".
 * A second copy of a statutory checklist is the last thing that should
 * be allowed to drift, hence one implementation with two doors.
 */
export async function computePayrollRunReadiness(input: {
  runId: string
  organizationId: string
}): Promise<RunReadiness | null> {
  const payload = await loadStatutoryRunPayload({
    runId: input.runId,
    organizationId: input.organizationId,
  })
  if (!payload) return null

  // Org-level missing fields.
  const orgIssues: RunReadinessOrgIssue[] = []
  const ci = payload.companyInfo
  for (const f of ORG_FIELDS) {
    if (isBlank(ci?.[f.key])) {
      orgIssues.push({ field: f.key, label: f.label })
    }
  }

  // Per-employee missing fields. Iterate every payslip in the run.
  const employeeIssues: RunReadinessEmployeeIssue[] = []
  for (const row of payload.rows) {
    const missing: string[] = []

    if (isBlank(row.employeeCode)) missing.push("Employee/payroll number")
    // PCB number (TIN / incomeTaxNumber) intentionally NOT in the
    // submit gate — see the header comment. The CP39 / PCB TXT file
    // checks it separately at generate time so admins can run payroll
    // for new joiners whose TIN hasn't been issued yet.

    // IC for Malaysians/PRs, passport for foreigners. Label tailored
    // so the admin knows which field to fix.
    const isLocalOrPr = isMalaysianNationality(row.nationality) || row.hasPr
    if (isLocalOrPr) {
      const ic = (row.idNumber ?? "").replace(/[^0-9]/g, "")
      if (ic.length === 0) missing.push("New IC number")
    } else {
      if (isBlank(row.idNumber)) missing.push("Passport number")
    }

    if (missing.length > 0) {
      employeeIssues.push({
        employeeCode: row.employeeCode,
        name: row.employeeName,
        missing,
      })
    }
  }

  const totalMissingCount =
    orgIssues.length +
    employeeIssues.reduce((sum, e) => sum + e.missing.length, 0)

  return {
    ok: totalMissingCount === 0,
    orgIssues,
    employeeIssues,
    totalMissingCount,
  }
}
