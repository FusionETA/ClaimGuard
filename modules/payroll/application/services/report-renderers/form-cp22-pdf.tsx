import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { isAdminRole } from "@/lib/auth/types"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { FormCp22PdfDocument } from "@/components/admin/payroll-employee-form-pdf-documents"
import { loadEmployeeFormPayload } from "@/modules/payroll/infrastructure/employee-form.repository"

/**
 * Render the CP22 new-employee notification for one employee.
 * Year is captured for filename purposes (defaults to the join year
 * when available; current year otherwise — the caller passes whatever
 * the UI's year picker shows).
 */
export async function renderFormCp22Pdf(input: {
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
    <FormCp22PdfDocument payload={payload} generatedAt={new Date()} />,
  )
}
