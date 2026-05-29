import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { isAdminRole } from "@/lib/auth/types"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { FormPcb2IiPdfDocument } from "@/components/admin/payroll-employee-form-pdf-documents"
import { loadEmployeeFormPayload } from "@/modules/payroll/infrastructure/employee-form.repository"

/**
 * Render the PCB 2(II) statement of payment for one employee for one
 * calendar year. Generates a single-page PDF buffer ready to stream
 * back from the route handler.
 *
 * Throws when:
 *   - Session expired / not admin
 *   - Employee doesn't belong to the active organisation
 *   - DB isn't reachable
 */
export async function renderFormPcb2IiPdf(input: {
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
    <FormPcb2IiPdfDocument payload={payload} generatedAt={new Date()} />,
  )
}
