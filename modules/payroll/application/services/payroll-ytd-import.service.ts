import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"
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
 * Process an uploaded YTD XLSX following the one-year-one-upload rule:
 *
 *   1. Parse the file.
 *   2. Pre-flight: if any month in the upload overlaps a COMPUTED run
 *      (DRAFT / PENDING / SUBMITTED), REJECT the entire upload with
 *      the list of conflicting months. Engine output is never
 *      overwritten or coexisted-with.
 *   3. Atomic replace: delete every IMPORTED run for (org, year),
 *      then write the new file's rows. The latest upload is the
 *      single source of truth for that year — months that were in
 *      the previous import but absent from the new one disappear.
 *   4. Unknown employees (no NRIC / Passport match in the org) are
 *      skipped and reported back; the import still succeeds for the
 *      rest.
 */
export type YtdImportSummary = {
  /// Number of IMPORTED runs created in the new write (one per month
  /// that had at least one matched employee row).
  importedRunsCreated: number
  /// Number of payslips written across all created runs.
  importedPayslips: number
  /// Imported runs that existed for this year BEFORE the upload and
  /// were wiped by the atomic replace. 0 on a first upload for the
  /// year. Surfaced so the admin sees the destructive scope.
  replacedRuns: number
  /// Per-employee skips — uploaded ID didn't match any existing
  /// employee in the org. Non-fatal; the rest of the upload still
  /// commits.
  skippedUnknownEmployees: Array<{ name: string; idNumber: string }>
  parserWarnings: string[]
  parserErrors: string[]
}

/**
 * Thrown when the upload overlaps a COMPUTED run. Caller renders the
 * conflicting months as a hard failure — admin must either remove the
 * matching months from the upload OR delete / unlock the COMPUTED runs
 * first.
 */
export class YtdImportConflictError extends Error {
  constructor(
    public readonly conflictingMonths: number[],
    public readonly year: number,
  ) {
    super(
      `Upload conflicts with ${conflictingMonths.length} computed payroll run${
        conflictingMonths.length === 1 ? "" : "s"
      } in ${year}. Imports cannot overwrite engine-produced runs.`,
    )
    this.name = "YtdImportConflictError"
  }
}

/**
 * Preview-only pass: returns the workbook's column headers classified
 * (mandatory / optional-legacy / standard-category / unknown / name+id).
 * The import dialog calls this when the admin picks a file so it can
 * surface a mapping UI for any UNKNOWN headers. Doesn't read data rows
 * and writes nothing to the DB. No conflict checks. Cheap.
 */
export async function previewYtdImportColumns(input: {
  file: Buffer
}): Promise<import("./report-renderers/ytd-import-parser").YtdImportColumnsPreview> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  // Admin gate is the only auth check — we don't read any DB data, so
  // no org-scope check is needed for the preview itself.
  const { previewYtdImportColumns: preview } = await import(
    "./report-renderers/ytd-import-parser"
  )
  return preview(input.file)
}

export async function importYtdPayrollHistory(input: {
  file: Buffer
  year: number
  /// Optional per-header overrides. Lets the admin map non-standard
  /// column names (e.g. "OT 1.5x" from a migrated payroll system) onto
  /// a known PayrollAdjustmentCategory. Keys are the **normalized**
  /// header text (lowercase, trimmed, whitespace-collapsed — see
  /// `normalizeHeader()` in the parser). Two distinct headers mapped
  /// to the same category get summed at calc time (each becomes its
  /// own customLineItem; both buckets add into the same totalAllowances
  /// / totalDeductions / totalReimbursements aggregate).
  columnOverrides?: import("./report-renderers/ytd-import-parser").YtdImportColumnOverrides
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
    replacedRuns: 0,
    skippedUnknownEmployees: [],
    parserWarnings: [],
    parserErrors: [],
  }

  // 1. Parse the workbook (with admin-supplied column overrides if any).
  const parsed = await parseYtdImport(input.file, {
    columnOverrides: input.columnOverrides,
  })
  summary.parserWarnings.push(...parsed.warnings)
  summary.parserErrors.push(...parsed.errors)
  if (parsed.errors.length > 0) {
    // File-level fatal — don't try to write anything.
    return summary
  }

  // 2. Group parsed rows by month so we know which periods this upload
  //    touches (used by the conflict check below + the write loop).
  const byMonth = new Map<number, ParsedYtdRow[]>()
  for (const r of parsed.rows) {
    const list = byMonth.get(r.monthIdx) ?? []
    list.push(r)
    byMonth.set(r.monthIdx, list)
  }
  const monthsInUpload = Array.from(byMonth.keys())
    .map((m) => m + 1)
    .sort((a, b) => a - b)

  // 3. Pre-flight conflict check — fail the entire upload if ANY month
  //    in the file overlaps a COMPUTED run for this org/year. The
  //    "one year, one upload" rule + "imports never coexist with engine
  //    output" rule mean a partial commit would be confusing AND wrong:
  //    the admin must either remove those months from the file or
  //    delete/unlock the computed runs first.
  const yearContext = await payrollRunRepository.listMonthsByYear({
    organizationId: orgId,
    year: input.year,
  })
  const conflictingMonths = monthsInUpload.filter((m) =>
    yearContext.computedMonths.includes(m),
  )
  if (conflictingMonths.length > 0) {
    throw new YtdImportConflictError(conflictingMonths, input.year)
  }

  // 4. Build the employee match map: normalised idNumber → match row.
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

  // 5. Atomic replace — wipe every IMPORTED run for this year before
  //    writing the new file. The cascade on PayrollRun.payslips clears
  //    out the old payslips along with their runs. After this point
  //    the year is empty of imported data; whatever we write next IS
  //    the year's full imported record.
  const { runsDeleted } =
    await payrollRunRepository.deleteImportedRunsForYear({
      organizationId: orgId,
      year: input.year,
    })
  summary.replacedRuns = runsDeleted

  // 6. Write the new rows.
  const unknownReported = new Set<string>() // dedupe per-employee skips
  for (const [monthIdx, rows] of byMonth) {
    const periodMonth = monthIdx + 1

    // findOrCreateImportedRun can no longer hit the COMPUTED conflict
    // branch (we filtered those upstream) and can no longer find an
    // existing IMPORTED row (we just deleted them all), so this is
    // effectively a plain create — kept via the existing repo method
    // so the run's defaults (status, submittedAt, source) stay in one
    // place.
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
        // Shouldn't happen post-pre-flight; if a COMPUTED run was
        // created in the millisecond gap between the check and now,
        // bail with the conflict so the admin sees the latest state.
        throw new YtdImportConflictError([periodMonth], input.year)
      }
      throw err
    }

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

      const payslipInput = buildImportedPayslipInput({ match, row })
      const { created } = await payslipRepository.addImportedPayslip({
        payrollRunId: runId,
        payslip: payslipInput,
      })
      // Dup-key (P2002) here would only happen if the same employee
      // appears twice in the same month block of the upload — a
      // genuine data error in the file. Silently ignore the second
      // occurrence; the first one stuck.
      if (created) summary.importedPayslips += 1
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

  // ── Split the custom-category line items into their buckets ──
  // BIK rows (nonCash: true on the meta) → totalBenefitsInKind. Don't
  // touch gross/net since the employee never receives cash. Cash
  // allowances → totalAllowances (folded into grossPay). Deductions
  // → totalDeductions (net-only). REIMBURSEMENT rows → totalReimbursements
  // AND netPay (employee receives the money via payroll, but it
  // isn't taxable income so it stays out of grossPay + statutory
  // bases). Before this bucket existed the import dropped REIMBURSEMENT
  // amounts entirely — Nicholas's screenshot showed an "Expense Claim"
  // line item rendered with a +RM 2,447 marker but the total ignored
  // it, because no scalar received the value.
  let extraCashAllowances = 0
  let extraBik = 0
  let extraDeductions = 0
  let extraReimbursements = 0
  for (const li of a.customLineItems) {
    const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[
      li.categoryCode as PayrollAdjustmentCategory
    ]
    if (!meta) continue
    if (meta.kind === "ALLOWANCE" && meta.nonCash) {
      extraBik += li.amount
    } else if (meta.kind === "ALLOWANCE") {
      extraCashAllowances += li.amount
    } else if (meta.kind === "DEDUCTION") {
      extraDeductions += li.amount
    } else if (meta.kind === "REIMBURSEMENT") {
      extraReimbursements += li.amount
    }
  }

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
    a.otherAllowance +
    extraCashAllowances
  // Unpaid leave is the only legit gross-reducing deduction column
  // on the template; the rest reduce net only.
  const grossReducingDeductions = a.unpaidLeave
  const netOnlyDeductions = a.netSalaryDeduction + extraDeductions

  const grossPay = round2(a.basicSalary + totalAllowances - grossReducingDeductions)
  // Reimbursements (e.g. Expense Claim) flow into net pay because the
  // employee actually receives the money this month, but NOT into
  // grossPay or statutory bases — they're non-taxable expense recovery.
  // Without this `+ extraReimbursements`, an imported "Expense Claim"
  // line item rendered in the breakdown but vanished from the
  // payroll-row total (Nicholas's screenshot).
  const totalReimbursements = round2(extraReimbursements)
  const netPay = round2(
    grossPay -
      a.epfEmployee -
      a.socsoEmployee -
      a.eisEmployee -
      a.pcb -
      netOnlyDeductions -
      a.zakat +
      totalReimbursements,
  )
  const totalCostToEmployer = round2(
    grossPay + a.epfEmployer + a.socsoEmployer + a.eisEmployer + a.hrdf,
  )
  const totalBenefitsInKind = round2(extraBik)

  // Materialise each non-zero adjustment column from the upload as a
  // PayslipLineItem so the run-detail UI can render the breakdown
  // (bonus / commission / per-allowance / etc.) instead of showing
  // only the collapsed totals scalar. Overtime is excluded — it has
  // its own `otPay` field on the payslip + a dedicated UI row, so
  // mirroring it as a line item would double-display. Zakat is also
  // excluded for the same reason (its own scalar).
  //
  // subjectToEpf / SOCSO / EIS / PCB are conservatively set to true:
  // the imported amounts represent what the previous payroll system
  // already taxed, so we want next month's YTD aggregator (which
  // only counts subjectToPcb allowances toward £Y) to include them.
  // If an admin needs to mark a specific allowance PCB-exempt
  // retroactively, they can edit the line item from the payslip
  // detail page.
  const lineItems: Array<{
    kind: "ALLOWANCE" | "DEDUCTION" | "REIMBURSEMENT"
    label: string
    amount: number
    /// YTD-imported rows never apply per-line taxExemptLimit clamping
    /// (the admin is entering pre-aggregated figures), so this is
    /// always null — the ytd read path falls back to `amount`.
    pcbTaxableAmount: number | null
    category: string | null
    subjectToEpf: boolean
    subjectToSocso: boolean
    subjectToEis: boolean
    subjectToPcb: boolean
  }> = []
  const pushAllowance = (label: string, amount: number) => {
    if (amount > 0) {
      lineItems.push({
        kind: "ALLOWANCE",
        label,
        amount: round2(amount),
        pcbTaxableAmount: null,
        category: null,
        subjectToEpf: true,
        subjectToSocso: true,
        subjectToEis: true,
        subjectToPcb: true,
      })
    }
  }
  const pushDeduction = (label: string, amount: number) => {
    if (amount > 0) {
      lineItems.push({
        kind: "DEDUCTION",
        label,
        amount: round2(amount),
        pcbTaxableAmount: null,
        category: null,
        // Deductions don't affect statutory bases — flags ignored on
        // the deduction path but set to false for clarity.
        subjectToEpf: false,
        subjectToSocso: false,
        subjectToEis: false,
        subjectToPcb: false,
      })
    }
  }
  pushAllowance("Bonus", a.bonus)
  pushAllowance("Commission", a.commission)
  pushAllowance("Service charge", a.serviceCharge)
  pushAllowance("Travel allowance", a.travelAllowance)
  pushAllowance("Parking allowance", a.parkingAllowance)
  pushAllowance("Phone allowance", a.phoneAllowance)
  pushAllowance("Other allowance", a.otherAllowance)
  pushDeduction("Unpaid leave", a.unpaidLeave)
  pushDeduction("Net salary deduction", a.netSalaryDeduction)

  // Custom-category line items — admin used a non-legacy column
  // header that matched a PAYROLL_ADJUSTMENT_CATEGORY_META label.
  // Each becomes its own line item with the FULL statutory flag set
  // sourced from the meta (so BIK correctly skips EPF/SOCSO/EIS but
  // contributes to PCB taxable income; deductions don't touch any
  // statutory base; etc.). Category code is persisted so next
  // month's YTD aggregator can apply tax-exempt-limit rules.
  for (const li of a.customLineItems) {
    const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[
      li.categoryCode as PayrollAdjustmentCategory
    ]
    if (!meta) continue
    lineItems.push({
      kind: meta.kind,
      label: meta.label,
      amount: round2(li.amount),
      pcbTaxableAmount: null,
      category: li.categoryCode,
      subjectToEpf: meta.subjectToEpf,
      subjectToSocso: meta.subjectToSocso,
      subjectToEis: meta.subjectToEis,
      subjectToPcb: meta.subjectToPcb,
    })
  }

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
    totalBenefitsInKind,
    totalReimbursements,
    totalDeductions: round2(grossReducingDeductions + netOnlyDeductions + a.zakat),
    epfEmployee: a.epfEmployee,
    epfEmployer: a.epfEmployer,
    socsoEmployee: a.socsoEmployee,
    socsoEmployer: a.socsoEmployer,
    eisEmployee: a.eisEmployee,
    eisEmployer: a.eisEmployer,
    // SKBBK didn't exist on the previous payroll system (pre Jun 2026)
    // so we have no historical data to import. Stays 0 on imported
    // payslips — when the org's first computed run in Jun 2026 lands,
    // SKBBK gets deducted there.
    //
    // `contributeToSkbbk` snapshot false — the payslip was imported,
    // not computed against a live opt-in decision. If admin later
    // re-edits this run, the recompute will read this false snapshot
    // and leave SKBBK at 0 (matching what was imported); admin can
    // enable SKBBK for future runs via the profile toggle instead.
    skbbkEmployee: 0,
    skbbkWage: 0,
    contributeToSkbbk: false,
    pcb: a.pcb,
    // YTD imports don't split out CP38 — historical payroll data
    // typically already merged it into the PCB total. Leave 0 unless
    // the template gains a dedicated CP38 column later.
    cp38: 0,
    pcbCalculation: null,
    hrdf: a.hrdf,
    hrdfWage: a.basicSalary, // approximation — admins can edit later
    zakat: a.zakat,
    grossPay,
    netPay,
    totalCostToEmployer,
    lineItems,
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

/**
 * Lightweight year-context lookup for the import dialog. Returns which
 * months of the calendar year already have data, split by source.
 *
 * The dialog uses this for two UX cues BEFORE the admin even picks a
 * file:
 *   - importedMonths.length > 0 → show "Re-uploading will replace N
 *     existing imported months" warning.
 *   - computedMonths.length > 0 → show "These months cannot be
 *     imported into" hint (the upload will fail if it touches them).
 *
 * Auth-gated like the other YTD service functions; returns empty
 * arrays when the session has no org context (defensive — the dialog
 * never reaches this path without a session).
 */
export async function getYtdImportYearContext(input: {
  year: number
}): Promise<{ importedMonths: number[]; computedMonths: number[] }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { importedMonths: [], computedMonths: [] }
  if (
    !Number.isInteger(input.year) ||
    input.year < 2000 ||
    input.year > 2100
  ) {
    return { importedMonths: [], computedMonths: [] }
  }
  return payrollRunRepository.listMonthsByYear({
    organizationId: orgId,
    year: input.year,
  })
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
