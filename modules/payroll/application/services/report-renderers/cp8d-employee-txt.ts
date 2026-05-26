import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import {
  cp8dTaxCategory,
  loadAnnualPayrollPayload,
} from "@/modules/payroll/application/services/report-renderers/annual-shared"
import { normaliseNewIc, normaliseTaxRef } from "@/modules/payroll/application/services/report-renderers/shared"

/**
 * CP8D Employee Particulars TXT — `P{employerNo}_{year}.TXT`.
 *
 * One pipe-delimited line per employee. Columns per the Altomate
 * sample we ported:
 *
 *   1. Name (uppercase, as on IC/passport)
 *   2. Income Tax No. (LHDN ref, 11 digits — SG/OG prefix stripped,
 *      wife code is the last digit)
 *   3. New IC (12 digits, no dashes)
 *   4. Tax Category (1 / 2 / 3 — see `cp8dTaxCategory`)
 *   5. Tax Borne by Employer (1 = Yes, 2 = No)
 *   6. Qualifying Children count
 *   7. Annual Child Relief (RM) — kept zero until child relief is
 *      fully wired into the calc engine
 *   8. Annual Gross Remuneration (RM, integer)
 *   9-13. Blank columns reserved by LHDN for future fields
 *   14. EPF (employee contribution, RM integer)
 *   15. Blank
 *   16. PCB / MTD (RM with 2 decimals)
 *
 * Trailing pipe + CRLF on each row, matching the Altomate sample.
 */
export async function renderCp8dEmployeeTxt(input: {
  year: number
}): Promise<Buffer> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const payload = await loadAnnualPayrollPayload({
    organizationId: orgId,
    year: input.year,
  })
  if (!payload) throw new Error("Could not load annual payroll data.")
  if (!payload.employerNo) {
    throw new Error(
      "Employer LHDN E-number is missing. Set it in Payroll Settings → Company Info before generating the CP8D TXT.",
    )
  }

  const lines: string[] = []

  for (const e of payload.employees) {
    // Skip employees with no tax ref and no PCB — nothing to report.
    if (!e.incomeTaxNumber && e.totalPcb === 0) continue

    const name = e.employeeName.toUpperCase()
    const taxRef = normaliseTaxRef(e.incomeTaxNumber)
    const ic = normaliseNewIc(e.idNumber)
    const category = cp8dTaxCategory({
      maritalStatus: e.maritalStatus,
      spouseWorking: e.spouseWorking,
      qualifyingChildren: e.qualifyingChildren,
    })
    const taxBorneByEmployer = e.pcbBorneByEmployer ? "1" : "2"
    const children = e.qualifyingChildren.toString()
    const childRelief = Math.round(e.annualChildRelief).toString()
    const annualGross = Math.round(e.grossSalary).toString()
    const epf = Math.round(e.totalEpfEmployee).toString()
    const pcb = e.totalPcb.toFixed(2)

    // 16 pipe-separated columns + trailing pipe (matches sample).
    const cols = [
      name,
      taxRef,
      ic,
      category,
      taxBorneByEmployer,
      children,
      childRelief,
      annualGross,
      "",
      "",
      "",
      "",
      "",
      epf,
      "",
      pcb,
    ]
    lines.push(cols.join("|") + "|")
  }

  const text = lines.join("\r\n") + (lines.length > 0 ? "\r\n" : "")
  return Buffer.from(text, "utf8")
}
