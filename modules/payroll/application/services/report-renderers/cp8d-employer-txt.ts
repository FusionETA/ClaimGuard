import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { loadAnnualPayrollPayload } from "@/modules/payroll/application/services/report-renderers/annual-shared"

/**
 * CP8D Employer Master TXT — `M{employerNo}_{year}.TXT`.
 *
 * Single pipe-delimited line:
 *   {employerNo}|{employerName}|{year}
 *
 * Example:
 *   0009089151|DEMO SDN BHD|2026
 */
export async function renderCp8dEmployerTxt(input: {
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

  const employerName = (payload.companyInfo?.employerName ?? payload.organizationName)
    .toUpperCase()
    .trim()

  // Pipe-delimited, no header. Trailing newline so LHDN parsers don't
  // complain about a missing EOL.
  const line = `${payload.employerNo}|${employerName}|${payload.year}\r\n`
  return Buffer.from(line, "utf8")
}
