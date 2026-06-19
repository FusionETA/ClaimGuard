import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { renderYtdImportTemplate } from "@/modules/payroll/application/services/report-renderers/ytd-import-template"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"

/**
 * Generate a downloadable YTD import template — XLSX pre-filled with
 * the active org's employees so the admin only has to type in the
 * historical numbers, not re-enter identity. See
 * `report-renderers/ytd-import-template.ts` for the file structure.
 *
 * Auth: admin only, scoped to the session's active organization.
 */
export async function generateYtdImportTemplate(input: {
  year: number
}): Promise<{ buffer: Buffer; filename: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  if (
    !Number.isInteger(input.year) ||
    input.year < 2000 ||
    input.year > 2100
  ) {
    throw new Error("Year must be a 4-digit year between 2000 and 2100.")
  }

  const [org, identityRows] = await Promise.all([
    organizationRepository.getOrganizationById(orgId),
    payrollProfileRepository.listIdentityForImport(orgId),
  ])

  const employees = identityRows.map((r) => ({
    name: r.name || "(no name)",
    personalIdLabel: formatPersonalIdLabel(r.idType, r.idNumber),
  }))

  const buffer = await renderYtdImportTemplate({
    organizationName: org?.name ?? "",
    year: input.year,
    employees,
  })

  // Slugify org name for the download filename — avoids weird URL
  // encoding when the admin's Downloads folder catches the file.
  const slug = (org?.name ?? "organisation")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)

  return {
    buffer,
    filename: `ytd-import-${slug}-${input.year}.xlsx`,
  }
}

function formatPersonalIdLabel(
  idType: "NRIC" | "PASSPORT" | "OTHER" | null,
  idNumber: string | null,
): string {
  if (!idNumber) {
    // No ID on file yet — leave a hint for the admin to fill it
    // before uploading. Importer rejects blank IDs.
    return "NRIC: "
  }
  switch (idType) {
    case "NRIC":
      return `NRIC: ${idNumber}`
    case "PASSPORT":
      return `Passport: ${idNumber}`
    case "OTHER":
      return `Other: ${idNumber}`
    default:
      // Heuristic when idType is missing — 12-digit-with-dashes-or-not
      // looks like a NRIC; anything else falls back to a generic label.
      return /^\d{6}-?\d{2}-?\d{4}$/.test(idNumber.replace(/\s/g, ""))
        ? `NRIC: ${idNumber}`
        : `Passport: ${idNumber}`
  }
}
