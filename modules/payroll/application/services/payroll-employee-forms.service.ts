import "server-only"

import { isAdminRole } from "@/lib/auth/types"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import {
  EMPLOYEE_FORM_META,
  type EmployeeFormKind,
  employeeFormFileName,
  isEmployeeFormAvailable,
} from "@/modules/payroll/domain/employee-forms"
import { loadEmployeeFormPayload } from "@/modules/payroll/infrastructure/employee-form.repository"
import { renderFormPcb2IiPdf } from "@/modules/payroll/application/services/report-renderers/form-pcb2ii-pdf"

/**
 * Per-employee LHDN form generator. Mirrors the annual-reports
 * service (`generatePayrollAnnualReport`) but for one employee at a
 * time, with the simpler "render on demand, no cache" strategy — these
 * are personal documents that don't pay back the overhead of file
 * caching.
 *
 * The route handler at `app/api/admin/payroll/employee-forms/[userId]/route.ts`
 * is the only caller. It streams the buffer + sets Content-Disposition
 * with the predictable file name from `employeeFormFileName(...)`.
 */
export async function generateEmployeeForm(input: {
  userId: string
  kind: EmployeeFormKind
  /// Calendar year for the form. Required for the year-scoped forms
  /// (PCB2II, TP3, CP22A, CP21). Ignored for forms whose
  /// `needsYearPicker` is false (currently only CP22 — and even there
  /// we still pass the join year for filename purposes).
  year: number
}): Promise<{
  buffer: Buffer
  fileName: string
  mimeType: string
}> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  // Active/archived gate. We re-load the payload anyway later for the
  // render, but a single pre-check gives a friendlier error message.
  const payload = await loadEmployeeFormPayload({
    organizationId: orgId,
    userId: input.userId,
    year: input.year,
  })
  if (!payload) {
    throw new Error("Employee not found in this organisation.")
  }
  if (
    !isEmployeeFormAvailable({
      kind: input.kind,
      isArchived: payload.employee.isArchived,
    })
  ) {
    const meta = EMPLOYEE_FORM_META[input.kind]
    throw new Error(
      meta.requires === "ARCHIVED_ONLY"
        ? `${meta.code} can only be generated for archived employees. Archive the employee first (with a last-working-day date) before generating this form.`
        : `${meta.code} can only be generated for active employees. This employee is currently archived.`,
    )
  }

  let buffer: Buffer
  switch (input.kind) {
    case "PCB2II":
      buffer = await renderFormPcb2IiPdf({
        userId: input.userId,
        year: input.year,
      })
      break
    case "CP22":
    case "CP22A":
    case "CP21":
    case "TP3":
      // The other four forms land in follow-up commits — guard rail
      // so we don't ship a broken button that 500s.
      throw new Error(`${input.kind} is not yet implemented.`)
  }

  return {
    buffer,
    fileName: employeeFormFileName({
      kind: input.kind,
      employeeCode: payload.employee.employeeCode,
      year: EMPLOYEE_FORM_META[input.kind].needsYearPicker ? input.year : null,
    }),
    mimeType: "application/pdf",
  }
}
