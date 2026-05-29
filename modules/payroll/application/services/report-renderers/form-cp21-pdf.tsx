import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { isAdminRole } from "@/lib/auth/types"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { FormCp21PdfDocument } from "@/components/admin/payroll-employee-form-pdf-documents"
import { loadEmployeeFormPayload } from "@/modules/payroll/infrastructure/employee-form.repository"

/**
 * Render the CP21 leaving-Malaysia notification for an archived
 * employee. Year drives the YTD section — figures cover 1 Jan up to
 * the expected departure date (which the admin fills by hand because
 * we don't model passport / travel data on PayrollProfile).
 */
export async function renderFormCp21Pdf(input: {
  userId: string
  year: number
}): Promise<Buffer> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const payload = await loadEmployeeFormPayload({
    organizationId: orgId,
    userId: input.userId,
    year: input.year,
  })
  if (!payload) {
    throw new Error("Employee not found in this organisation.")
  }

  return renderToBuffer(
    <FormCp21PdfDocument payload={payload} generatedAt={new Date()} />,
  )
}
