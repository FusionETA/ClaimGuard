import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { renderToBuffer } from "@react-pdf/renderer"

import { FormEaBulkPdfDocument } from "@/components/admin/payroll-annual-pdf-documents"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { loadAnnualPayrollPayload } from "@/modules/payroll/application/services/report-renderers/annual-shared"

export async function renderFormEaBulkPdf(input: {
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
  if (payload.employees.length === 0) {
    throw new Error(
      `No SUBMITTED payroll runs found for ${input.year}. Submit + approve at least one run before generating Form EA.`,
    )
  }

  return renderToBuffer(
    <FormEaBulkPdfDocument payload={payload} generatedAt={new Date()} />,
  )
}
