import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { isAdminRole } from "@/lib/auth/types"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { FormTp3PdfDocument } from "@/components/admin/payroll-employee-form-pdf-documents"
import { loadEmployeeFormPayload } from "@/modules/payroll/infrastructure/employee-form.repository"

/**
 * Render the TP3 handover form for a leaving employee. Year drives
 * the YTD section — the employee takes this to their next employer so
 * PCB is computed correctly for the rest of the calendar year.
 */
export async function renderFormTp3Pdf(input: {
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
    <FormTp3PdfDocument payload={payload} generatedAt={new Date()} />,
  )
}
