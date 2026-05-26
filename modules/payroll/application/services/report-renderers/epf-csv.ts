import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { resolveActiveOrgId, getCurrentSession } from "@/lib/auth/session"
import {
  loadStatutoryRunPayload,
  type StatutoryEmployeeRow,
} from "@/modules/payroll/application/services/report-renderers/shared"

/**
 * EPF Contribution CSV (KWSP i-Akaun Majikan bulk upload).
 *
 * Columns (with header row):
 *   Member EPF No., Member IC No., Member Name, Member Wage,
 *   Employer Contribution Amount, Member Contribution Amount
 *
 * - Member Wage: RM with 2 decimals (gross wage subject to EPF).
 * - Employer/Member Contribution Amount: whole RM (rounded up to the
 *   nearest ringgit per KWSP's Third Schedule rules, which the calc
 *   engine already applies).
 * - Employees without an EPF number on file are SKIPPED — KWSP rejects
 *   rows with missing or zero EPF numbers. Admin sees the count of
 *   skipped rows in the toast.
 *
 * Line endings: CRLF. Encoding: UTF-8 (no BOM — i-Akaun parses fine).
 */
export async function renderEpfCsv(input: {
  runId: string
}): Promise<Buffer> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const payload = await loadStatutoryRunPayload({
    runId: input.runId,
    organizationId: orgId,
  })
  if (!payload) throw new Error("Payroll run not found.")

  const header = [
    "Member EPF No.",
    "Member IC No.",
    "Member Name",
    "Member Wage",
    "Employer Contribution Amount",
    "Member Contribution Amount",
  ].join(",")

  const lines: string[] = [header]

  for (const row of payload.rows) {
    // Skip employees without EPF on file — i-Akaun rejects them anyway.
    if (!row.epfNumber || row.epfNumber.trim().length === 0) continue
    // Skip rows with both contributions == 0 (foreigners on EIS-only,
    // archived employees with stub payslips, etc.) — nothing to remit.
    if (row.payslip.epfEmployee === 0 && row.payslip.epfEmployer === 0) continue

    const ic = (row.idNumber ?? "").replace(/[^0-9A-Za-z]/g, "")

    lines.push(
      [
        csvField(row.epfNumber),
        csvField(ic),
        csvField(row.employeeName),
        // Wage subject to EPF — use grossPay (basic + OT + cash
        // allowances). KWSP's Third Schedule already applied to
        // produce the contribution amounts; this column is
        // informational on the upload.
        row.payslip.grossPay.toFixed(2),
        Math.round(row.payslip.epfEmployer).toString(),
        Math.round(row.payslip.epfEmployee).toString(),
      ].join(","),
    )
  }

  // Trailing newline so editors don't show a "no newline at EOF" warning.
  const text = lines.join("\r\n") + "\r\n"
  return Buffer.from(text, "utf8")
}

/// Quote + escape a CSV field per RFC 4180 — only when needed (contains
/// a comma, quote, or newline). Names with apostrophes / hyphens
/// don't need quoting, which keeps the file close to KWSP's published
/// sample.
function csvField(value: string | null | undefined): string {
  const v = (value ?? "").toString()
  if (v === "") return ""
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`
  }
  return v
}

// Suppress unused-import lint
void ({} as StatutoryEmployeeRow)
