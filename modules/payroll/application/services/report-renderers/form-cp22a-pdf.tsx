import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { isAdminRole } from "@/lib/auth/types"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { FormCp22aPdfDocument } from "@/components/admin/payroll-employee-form-pdf-documents"
import { loadEmployeeFormPayload } from "@/modules/payroll/infrastructure/employee-form.repository"

/**
 * Render the CP22A cessation notification for an archived employee.
 * Year drives the YTD section — figures cover 1 Jan → leaveDate.
 *
 * The active/archived gate runs in the calling service
 * (`generateEmployeeForm`), so by the time this is invoked the
 * employee is guaranteed to be archived with a leaveDate.
 */
export async function renderFormCp22aPdf(input: {
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
    <FormCp22aPdfDocument payload={payload} generatedAt={new Date()} />,
  )
}
