import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import {
  EMPLOYEE_IMPORT_COLUMNS,
  MAX_TEMPLATE_CHILDREN,
} from "@/modules/payroll/domain/employee-import-columns"
import { buildEmployeeWorkbookBuffer } from "@/modules/payroll/application/services/report-renderers/employee-workbook"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"

/**
 * Export every employee in the active org to a styled XLSX that shares
 * its design + column order with the bulk-import template
 * (`report-renderers/employee-workbook.ts`), so the file is directly
 * re-importable. Column definitions are the single source of truth in
 * `domain/employee-import-columns.ts` — add a column there once and both
 * the template and this export pick it up.
 */
export async function exportPayrollEmployeesXlsx(): Promise<{
  buffer: Buffer
  filename: string
  employeeCount: number
}> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const dataRows = await buildEmployeeExportRows(orgId)
  const buffer = await buildEmployeeWorkbookBuffer({ mode: "export", dataRows })
  return {
    buffer,
    filename: "payroll-employees-export.xlsx",
    employeeCount: dataRows.length,
  }
}

/// Build one string[] per employee, in EMPLOYEE_IMPORT_COLUMNS order.
/// Session-free (the caller checks auth) so the XLSX builder can consume
/// it directly.
async function buildEmployeeExportRows(orgId: string): Promise<string[][]> {
  const employees = await payrollProfileRepository.listForExport(orgId)

  const str = (v: unknown): string => (v == null ? "" : String(v))
  const bool = (v: boolean | null | undefined): string =>
    v == null ? "" : v ? "TRUE" : "FALSE"

  const dataRows = employees.map((e) => {
    const p = e.profile
    // Build a { columnKey → cell } bag; anything not set falls back to
    // "" when emitted in column order below.
    const cell: Record<string, string> = {
      name: str(e.name),
      email: str(e.email),
      employeeId: str(e.employeeId),
      jobTitle: str(e.jobTitle),
      employeeType: str(e.employeeType),
      policyName: str(e.policyName),
      projectCode: str(e.projectName),
      teamCode: str(e.teamName),
      teamLayer: str(e.teamLayer),
    }
    if (p) {
      Object.assign(cell, {
        joinDate: str(p.joinDate),
        leaveDate: str(p.leaveDate),
        archiveReason: str(p.archiveReason),
        reportedToLhdn: bool(p.reportedToLhdn),
        dateOfBirth: str(p.dateOfBirth),
        gender: str(p.gender),
        race: str(p.race),
        nationality: str(p.nationality),
        maritalStatus: str(p.maritalStatus),
        hasPr: bool(p.hasPr),
        isResident: bool(p.isResident),
        isOku: bool(p.isOku),
        idType: str(p.idType),
        idNumber: str(p.idNumber),
        alternateEmail: str(p.alternateEmail),
        phone: str(p.phone),
        addressLine1: str(p.addressLine1),
        addressLine2: str(p.addressLine2),
        addressLine3: str(p.addressLine3),
        city: str(p.city),
        postcode: str(p.postcode),
        state: str(p.state),
        emergencyContactName: str(p.emergencyContactName),
        emergencyContactPhone: str(p.emergencyContactPhone),
        emergencyContactRelation: str(p.emergencyContactRelation),
        spouseWorking: bool(p.spouseWorking),
        spouseDisabled: bool(p.spouseDisabled),
        spousePcbNumber: str(p.spousePcbNumber),
        spouseIdNumber: str(p.spouseIdNumber),
        salaryType: str(p.salaryType),
        monthlySalary: str(p.monthlySalary),
        hourlyRate: str(p.hourlyRate),
        contributeToEpf: bool(p.contributeToEpf),
        epfNumber: str(p.epfNumber),
        epfMemberBefore1998: bool(p.epfMemberBefore1998),
        epfEmployeeRate: str(p.epfEmployeeRate),
        epfEmployeeVoluntary: str(p.epfEmployeeVoluntary),
        epfEmployerVoluntary: str(p.epfEmployerVoluntary),
        pcbBorneByEmployer: bool(p.pcbBorneByEmployer),
        incomeTaxNumber: str(p.incomeTaxNumber),
        socsoScheme: str(p.socsoScheme),
        socsoNumber: str(p.socsoNumber),
        contributeToEis: bool(p.contributeToEis),
        contributeToSkbbk: bool(p.contributeToSkbbk),
        ssfwNumber: str(p.ssfwNumber),
        bankName: str(p.bankName),
        bankAccountHolderName: str(p.bankAccountHolderName),
        bankAccountNumber: str(p.bankAccountNumber),
        paymentMethod: str(p.paymentMethod),
      })
      // Dependent-child columns from the childRelief array. `age` is a
      // legacy column not stored anymore — always blank on export.
      const children = p.childRelief ?? []
      for (let n = 1; n <= MAX_TEMPLATE_CHILDREN; n++) {
        const c = children[n - 1]
        if (!c) continue
        cell[`child${n}.abilityStatus`] = str(c.abilityStatus)
        cell[`child${n}.currentlyStudying`] = str(c.currentlyStudying)
        cell[`child${n}.pcbDeduction`] = str(c.pcbDeduction)
      }
    }
    return EMPLOYEE_IMPORT_COLUMNS.map((col) => cell[col.key] ?? "")
  })

  return dataRows
}
