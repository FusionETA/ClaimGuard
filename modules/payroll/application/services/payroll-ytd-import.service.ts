import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
import {
  parseYtdImport,
  type ParsedYtdRow,
} from "@/modules/payroll/application/services/report-renderers/ytd-import-parser"
import { renderYtdImportTemplate } from "@/modules/payroll/application/services/report-renderers/ytd-import-template"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"
import {
  ImportedRunConflictError,
  payrollRunRepository,
} from "@/modules/payroll/infrastructure/payroll-run.repository"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"

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

/**
 * Process an uploaded YTD XLSX: parse → match employees by NRIC /
 * Passport → find-or-create one IMPORTED PayrollRun per period →
 * append one Payslip per (employee, period). Skips unknown employees
 * and periods that already have a COMPUTED run (engine output is
 * never overwritten by imports). Returns a structured summary the
 * dialog renders back to the admin.
 */
export type YtdImportSummary = {
  importedRunsCreated: number
  importedPayslips: number
  skippedUnknownEmployees: Array<{ name: string; idNumber: string }>
  skippedExistingPayslips: Array<{
    name: string
    year: number
    monthIdx: number
    reason: string
  }>
  skippedConflictingPeriods: Array<{
    year: number
    monthIdx: number
    reason: string
  }>
  parserWarnings: string[]
  parserErrors: string[]
}

export async function importYtdPayrollHistory(input: {
  file: Buffer
  year: number
}): Promise<YtdImportSummary> {
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

  const summary: YtdImportSummary = {
    importedRunsCreated: 0,
    importedPayslips: 0,
    skippedUnknownEmployees: [],
    skippedExistingPayslips: [],
    skippedConflictingPeriods: [],
    parserWarnings: [],
    parserErrors: [],
  }

  // 1. Parse the workbook.
  const parsed = await parseYtdImport(input.file)
  summary.parserWarnings.push(...parsed.warnings)
  summary.parserErrors.push(...parsed.errors)
  if (parsed.errors.length > 0) {
    // File-level fatal — don't try to write anything.
    return summary
  }

  // 2. Build the employee match map: normalised idNumber → match row.
  const matchRows =
    await payrollProfileRepository.listEmployeesForImportMatch(orgId)
  const matchByNormalisedId = new Map<
    string,
    (typeof matchRows)[number]
  >()
  for (const row of matchRows) {
    const norm = normaliseProfileIdNumber(row.idType, row.idNumber)
    if (!norm) continue
    matchByNormalisedId.set(norm, row)
  }

  // 3. Group parsed rows by month — one IMPORTED run per (org, year,
  //    month). Within each month, walk the employee rows.
  const byMonth = new Map<number, ParsedYtdRow[]>()
  for (const r of parsed.rows) {
    const list = byMonth.get(r.monthIdx) ?? []
    list.push(r)
    byMonth.set(r.monthIdx, list)
  }

  const unknownReported = new Set<string>() // dedupe per-employee skips

  for (const [monthIdx, rows] of byMonth) {
    const periodMonth = monthIdx + 1

    // Find-or-create the run for this period.
    let runId: string
    try {
      const { run, created } = await payrollRunRepository.findOrCreateImportedRun({
        organizationId: orgId,
        periodYear: input.year,
        periodMonth,
        submittedById: session.userId,
      })
      runId = run.id
      if (created) summary.importedRunsCreated += 1
    } catch (err) {
      if (err instanceof ImportedRunConflictError) {
        summary.skippedConflictingPeriods.push({
          year: input.year,
          monthIdx,
          reason: err.message,
        })
        continue
      }
      throw err
    }

    // Append payslips.
    for (const row of rows) {
      const match = matchByNormalisedId.get(row.idNumberNormalised)
      if (!match) {
        if (!unknownReported.has(row.idNumberNormalised)) {
          summary.skippedUnknownEmployees.push({
            name: row.employeeName,
            idNumber: row.idNumber,
          })
          unknownReported.add(row.idNumberNormalised)
        }
        continue
      }

      const payslipInput = buildImportedPayslipInput({
        match,
        row,
      })

      const { created } = await payslipRepository.addImportedPayslip({
        payrollRunId: runId,
        payslip: payslipInput,
      })
      if (created) {
        summary.importedPayslips += 1
      } else {
        summary.skippedExistingPayslips.push({
          name: row.employeeName,
          year: input.year,
          monthIdx,
          reason: "Payslip already exists on this imported run.",
        })
      }
    }

    // Recompute the run's cached totals so the runs list shows the
    // right numbers right after upload.
    await payslipRepository.refreshRunTotals({ payrollRunId: runId })
  }

  // Cache-bust so the runs list re-reads from DB.
  await bustPayrollCaches({ organizationId: orgId })

  return summary
}

/**
 * Build a Payslip-create payload from a single parsed YTD row.
 * Statutory amounts are taken verbatim from the upload; gross / net /
 * cost-to-employer are derived so the run-totals look sensible.
 *
 * Imported payslips don't run through the calc engine — we don't have
 * the rates that were in effect on the previous payroll system, just
 * the resulting numbers. snapshotEpfRates is therefore a placeholder
 * (all zero) which is enough to satisfy the JSON column shape.
 */
function buildImportedPayslipInput(input: {
  match: Awaited<
    ReturnType<typeof payrollProfileRepository.listEmployeesForImportMatch>
  >[number]
  row: ParsedYtdRow
}) {
  const m = input.match
  const a = input.row.amounts

  // Allowance + deduction buckets — keeps the per-line breakdown out
  // of scope for the MVP, but the imported totals still feed
  // gross/net correctly.
  const totalAllowances =
    a.bonus +
    a.commission +
    a.overtime +
    a.serviceCharge +
    a.travelAllowance +
    a.parkingAllowance +
    a.phoneAllowance +
    a.otherAllowance
  // Unpaid leave is the only legit gross-reducing deduction column
  // on the template; the rest reduce net only.
  const grossReducingDeductions = a.unpaidLeave
  const netOnlyDeductions = a.netSalaryDeduction

  const grossPay = round2(a.basicSalary + totalAllowances - grossReducingDeductions)
  const netPay = round2(
    grossPay -
      a.epfEmployee -
      a.socsoEmployee -
      a.eisEmployee -
      a.pcb -
      netOnlyDeductions -
      a.zakat,
  )
  const totalCostToEmployer = round2(
    grossPay + a.epfEmployer + a.socsoEmployer + a.eisEmployer + a.hrdf,
  )

  return {
    employeeProfileId: m.employeeProfileId,
    payrollProfileId: m.payrollProfileId,
    snapshotName: m.name,
    snapshotEmployeeId: m.employeeId,
    snapshotPosition: m.jobTitle,
    snapshotSalaryType: m.salaryType,
    snapshotMonthlySalary:
      m.salaryType === "MONTHLY" ? (m.monthlySalary ?? a.basicSalary) : null,
    snapshotHourlyRate: null,
    snapshotNationality: m.nationality,
    snapshotIsResident: m.isResident,
    // Placeholder rates — imports skip the calc engine, so the actual
    // contribution amounts are typed in by the admin, not derived
    // from these.
    snapshotEpfRates: {
      employee: 0,
      employer: 0,
      voluntaryEmployee: 0,
      voluntaryEmployer: 0,
    },
    basicPay: a.basicSalary,
    proratedPay: a.basicSalary,
    workedHours: null,
    expectedHours: null,
    unpaidLeaveDays: a.unpaidLeave > 0 ? a.unpaidLeave : null,
    proratedFactor: 1.0,
    proratedDays: null,
    totalWorkingDays: null,
    otNormalHours: 0,
    otRestHours: 0,
    otPublicHours: 0,
    otPay: a.overtime,
    totalAllowances,
    totalBenefitsInKind: 0,
    totalReimbursements: 0,
    totalDeductions: round2(grossReducingDeductions + netOnlyDeductions + a.zakat),
    epfEmployee: a.epfEmployee,
    epfEmployer: a.epfEmployer,
    socsoEmployee: a.socsoEmployee,
    socsoEmployer: a.socsoEmployer,
    eisEmployee: a.eisEmployee,
    eisEmployer: a.eisEmployer,
    pcb: a.pcb,
    pcbCalculation: null,
    hrdf: a.hrdf,
    hrdfWage: a.basicSalary, // approximation — admins can edit later
    zakat: a.zakat,
    grossPay,
    netPay,
    totalCostToEmployer,
    lineItems: [],
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function normaliseProfileIdNumber(
  idType: "NRIC" | "PASSPORT" | "OTHER" | null,
  idNumber: string | null,
): string | null {
  if (!idNumber) return null
  switch (idType) {
    case "NRIC":
      return idNumber.replace(/\D/g, "")
    case "PASSPORT":
    case "OTHER":
      return idNumber.replace(/\s/g, "").toUpperCase()
    default:
      // Unknown type — try both shapes and pick the more specific one.
      // NRIC pattern check; fall through to alphanumeric upper otherwise.
      if (/^\d{6}-?\d{2}-?\d{4}$/.test(idNumber.replace(/\s/g, ""))) {
        return idNumber.replace(/\D/g, "")
      }
      return idNumber.replace(/\s/g, "").toUpperCase()
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
