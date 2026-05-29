/**
 * Per-employee LHDN form metadata + types.
 *
 * Separate from `annual-reports.ts` because these are PER-EMPLOYEE
 * forms (one PDF per employee per event) rather than annual bulk
 * exports. Each is downloadable from the payroll-employee detail page.
 *
 * Forms covered:
 *   - PCB2(II)  — on-request PCB allocation statement (any employee, any year)
 *   - CP22      — new-employee notification (within 30 days of join)        [pending]
 *   - CP22A     — cessation notification (archived employees only)          [pending]
 *   - CP21      — leaving-Malaysia notification (archived employees only)   [pending]
 *   - TP3       — handover to next employer (archived employees only)       [pending]
 *
 * Per the AltomateHR-branded summary doc strategy: each PDF contains
 * every LHDN-required field, in our own clean layout. HR uses the PDF
 * as the source-of-truth to transcribe onto the official LHDN form OR
 * paste into LHDN's e-PCB portal.
 */

export const EMPLOYEE_FORM_KINDS = [
  "PCB2II",
  "CP22",
  "CP22A",
  "CP21",
  "TP3",
] as const

export type EmployeeFormKind = (typeof EMPLOYEE_FORM_KINDS)[number]

export type EmployeeFormMeta = {
  kind: EmployeeFormKind
  /// LHDN form code as printed on the official PDF.
  code: string
  /// Short title for buttons.
  title: string
  /// Longer description shown in the LHDN Forms card under the button.
  description: string
  /// Whether the form requires the employee to be active or archived.
  /// "ANY" = available regardless of archive status.
  requires: "ANY" | "ACTIVE_ONLY" | "ARCHIVED_ONLY"
  /// Whether the form needs a year picker (year-scoped) or operates on
  /// employee-state-at-generation-time.
  needsYearPicker: boolean
}

export const EMPLOYEE_FORM_META: Record<EmployeeFormKind, EmployeeFormMeta> = {
  PCB2II: {
    kind: "PCB2II",
    code: "PCB 2(II)",
    title: "Statement of payment",
    description:
      "Monthly MTD (PCB) deductions paid for this employee. Generate on LHDN's request, e.g. during tax clearance or to reconcile a misallocated PCB payment.",
    requires: "ANY",
    needsYearPicker: true,
  },
  CP22: {
    kind: "CP22",
    code: "CP22",
    title: "New-employee notification",
    description:
      "Notification to LHDN that a new employee subject to tax has joined. Must be submitted within 30 days of the join date.",
    requires: "ACTIVE_ONLY",
    needsYearPicker: false,
  },
  CP22A: {
    kind: "CP22A",
    code: "CP22A",
    title: "Cessation notification",
    description:
      "Notification to LHDN that an employee subject to tax is leaving. Must be submitted at least 30 days before cessation (or 30 days after death).",
    requires: "ARCHIVED_ONLY",
    needsYearPicker: false,
  },
  CP21: {
    kind: "CP21",
    code: "CP21",
    title: "Leaving-Malaysia notification",
    description:
      "Notification to LHDN that an employee is leaving Malaysia for more than 3 months. Must be submitted at least 30 days before departure.",
    requires: "ARCHIVED_ONLY",
    needsYearPicker: false,
  },
  TP3: {
    kind: "TP3",
    code: "PCB/TP3",
    title: "Handover for next employer",
    description:
      "YTD income, EPF, zakat, and PCB figures the employee can hand to their next employer so the new payroll calculates PCB correctly for the rest of the year.",
    requires: "ARCHIVED_ONLY",
    needsYearPicker: false,
  },
}

/**
 * Canonical download file name. Mirrors the EA pattern
 * (`Form_EA_2026_Bulk.pdf`) — predictable for admins downloading
 * multiple files.
 */
export function employeeFormFileName(input: {
  kind: EmployeeFormKind
  employeeCode: string
  year: number | null
}): string {
  const meta = EMPLOYEE_FORM_META[input.kind]
  const tag = input.year != null ? `_${input.year}` : ""
  const safeCode = input.employeeCode.replace(/[^A-Za-z0-9_-]/g, "_")
  return `${meta.code.replace(/[^A-Za-z0-9]/g, "")}_${safeCode}${tag}.pdf`
}

/**
 * Decide whether the form button should be enabled given the
 * employee's current archive status.
 */
export function isEmployeeFormAvailable(input: {
  kind: EmployeeFormKind
  isArchived: boolean
}): boolean {
  const meta = EMPLOYEE_FORM_META[input.kind]
  switch (meta.requires) {
    case "ANY":
      return true
    case "ACTIVE_ONLY":
      return !input.isArchived
    case "ARCHIVED_ONLY":
      return input.isArchived
  }
}
