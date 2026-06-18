import { NextResponse } from "next/server"

/**
 * GET /admin/payroll/employees/import-template
 *
 * Streams the canonical CSV template for bulk employee imports.
 * Required columns are prefixed with `*` in the header row so admins
 * can see at a glance which fields are mandatory.
 *
 * Two example rows are pre-filled so non-technical HR can pattern-
 * match the formats. The comment row at the top documents the
 * accepted values.
 */
export async function GET() {
  const csv = buildTemplateCsv()
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="payroll-employee-import-template.csv"',
      "Cache-Control": "no-store",
    },
  })
}

/**
 * Column metadata for the template. `required: true` columns are
 * prefixed with `*` in the header — anything else is optional.
 * Order: required first, then statutory, then bank, then optional.
 */
type Column = {
  key: string
  required: boolean
  description: string
}

const COLUMNS: Column[] = [
  // ── Identity & Employment ──
  { key: "name", required: true, description: "Full legal name" },
  { key: "email", required: true, description: "Login email, must be unique in the org" },
  { key: "employeeId", required: true, description: "Org-specific employee code, e.g. EMP-001" },
  { key: "jobTitle", required: true, description: "Free-text job title" },
  { key: "employeeType", required: true, description: "EMPLOYEE | SUPERVISOR — admins cannot be created via import" },
  { key: "joinDate", required: true, description: "YYYY-MM-DD; required for proration" },
  { key: "leaveDate", required: false, description: "YYYY-MM-DD — last day of employment (only if leaving)" },
  { key: "archiveReason", required: false, description: "Reason for leaving — only if leaveDate is set" },
  { key: "reportedToLhdn", required: false, description: "TRUE/FALSE — final payroll reported to LHDN" },
  // ── Personal & Contact ──
  { key: "dateOfBirth", required: true, description: "YYYY-MM-DD; default password = email + MMDD" },
  { key: "gender", required: false, description: "MALE | FEMALE" },
  { key: "race", required: false, description: "LHDN race code (M/C/I/O)" },
  { key: "nationality", required: true, description: "Malaysian / Indonesian / etc." },
  { key: "maritalStatus", required: false, description: "SINGLE | MARRIED | DIVORCED | WIDOWED" },
  { key: "hasPr", required: false, description: "TRUE/FALSE — Permanent Resident flag" },
  { key: "isResident", required: false, description: "TRUE/FALSE — tax resident status, default TRUE" },
  { key: "isOku", required: false, description: "TRUE/FALSE — OKU (disabled) status" },
  { key: "idType", required: false, description: "NRIC | PASSPORT | ARMY_NO | POLICE_NO" },
  { key: "idNumber", required: false, description: "Identification number" },
  { key: "alternateEmail", required: false, description: "Personal / alternate email" },
  { key: "phone", required: false, description: "Contact phone — used for forgot-password WhatsApp code when provided; at least 7 digits, or leave blank" },
  { key: "addressLine1", required: false, description: "Street address line 1" },
  { key: "addressLine2", required: false, description: "Street address line 2" },
  { key: "addressLine3", required: false, description: "Street address line 3" },
  { key: "city", required: false, description: "City" },
  { key: "postcode", required: false, description: "Postcode" },
  { key: "state", required: false, description: "State" },
  { key: "emergencyContactName", required: false, description: "Emergency contact full name" },
  { key: "emergencyContactPhone", required: false, description: "Emergency contact phone number" },
  { key: "emergencyContactRelation", required: false, description: "Parent / Spouse / Sibling / etc." },
  // ── Spouse ──
  // Dependent-child columns (child1..child10) live at the END of the
  // template — see CHILD_COLUMNS below. They're optional and most
  // employees only fill the first few, so they're parked last to keep
  // the everyday columns up front.
  { key: "spouseWorking", required: false, description: "TRUE/FALSE — spouse is employed" },
  { key: "spouseDisabled", required: false, description: "TRUE/FALSE — spouse is OKU / disabled" },
  { key: "spousePcbNumber", required: false, description: "Spouse's LHDN PCB number" },
  { key: "spouseIdNumber", required: false, description: "Spouse's NRIC / passport number" },
  // ── Statutory & Payroll ──
  { key: "salaryType", required: true, description: "MONTHLY or HOURLY" },
  { key: "monthlySalary", required: false, description: "MYR — required if salaryType=MONTHLY" },
  { key: "hourlyRate", required: false, description: "MYR — required if salaryType=HOURLY" },
  { key: "contributeToEpf", required: false, description: "TRUE/FALSE — contributes to EPF, default TRUE" },
  { key: "epfNumber", required: false, description: "KWSP member number" },
  { key: "epfMemberBefore1998", required: false, description: "TRUE/FALSE — drives Part A/C vs Part F" },
  { key: "epfEmployeeRate", required: false, description: "Employee EPF % — default 11 (accepts 11 or 11%)" },
  { key: "epfEmployeeVoluntary", required: false, description: "Voluntary employee EPF % on top of mandatory" },
  { key: "epfEmployerVoluntary", required: false, description: "Voluntary employer EPF % on top of mandatory" },
  { key: "pcbBorneByEmployer", required: false, description: "TRUE/FALSE — PCB borne by employer" },
  { key: "incomeTaxNumber", required: false, description: "LHDN PCB number; PCB stays 0 until this is filled" },
  { key: "socsoScheme", required: false, description: "EMPLOYMENT_INJURY_INVALIDITY | EMPLOYMENT_INJURY_ONLY — auto-derived from date of birth when blank (under 55 → INVALIDITY, 60+ → INJURY_ONLY; 55–59 must be set manually)" },
  { key: "socsoNumber", required: false, description: "PERKESO number — defaults to the idNumber (NRIC / passport) when blank, since they're usually the same in Malaysia" },
  { key: "contributeToEis", required: false, description: "TRUE/FALSE — default TRUE for Malaysians" },
  { key: "ssfwNumber", required: false, description: "SSFW number — foreign workers only" },
  // ── Bank ──
  { key: "bankName", required: false, description: "e.g. Maybank, CIMB, RHB" },
  { key: "bankAccountHolderName", required: false, description: "Defaults to employee name if blank" },
  { key: "bankAccountNumber", required: false, description: "Account number" },
  { key: "paymentMethod", required: false, description: "BANK_TRANSFER | CASH | CHEQUE (default BANK_TRANSFER)" },

  // ── Hierarchy ──
  // The import wizard's preview picker offers "+ Create new" inline
  // for any of these that don't already exist in this org. Names are
  // matched case-insensitively, so "Fusion" and "FUSION" resolve to
  // the same record. If a CSV row leaves these blank, the admin can
  // assign them per-row in the preview picker before committing.
  { key: "policyName", required: true, description: "Name of the employee policy in this org (pick or + Create in the preview picker if missing)" },
  { key: "projectCode", required: true, description: "Project name in this org (pick or + Create in the preview picker if missing)" },
  { key: "teamCode", required: true, description: "Team name within the project (pick or + Create in the preview picker if missing)" },
  { key: "teamLayer", required: true, description: "Hierarchy layer (1 = bottom). Must be ≤ team.layerCount" },
]

/**
 * Dependent-child columns (child1..child10), parked at the very end of
 * the template. All optional — fill only as many as the employee has
 * (blank `ageN` rows are ignored on import). The importer reads
 * `childN.*` dynamically, so this count can be raised here alone.
 */
const MAX_TEMPLATE_CHILDREN = 10

const CHILD_COLUMNS: Column[] = Array.from(
  { length: MAX_TEMPLATE_CHILDREN },
  (_, i) => i + 1,
).flatMap((n) => [
  { key: `child${n}.age`, required: false, description: `Dependent child ${n} — age in years (leave blank if no child ${n})` },
  { key: `child${n}.abilityStatus`, required: false, description: `Dependent child ${n} — NORMAL | DISABLED` },
  { key: `child${n}.currentlyStudying`, required: false, description: `Dependent child ${n} — PRESCHOOL | PRIMARY | SECONDARY | HIGHER_ED | NONE` },
  { key: `child${n}.pcbDeduction`, required: false, description: `Dependent child ${n} — FULL | HALF | NONE` },
])

/// Final template column order: everyday columns first, dependent-child
/// columns last.
const ALL_COLUMNS: Column[] = [...COLUMNS, ...CHILD_COLUMNS]

function buildTemplateCsv(): string {
  const headerCells = ALL_COLUMNS.map((c) =>
    csvField((c.required ? "*" : "") + c.key),
  )
  const commentCells = ALL_COLUMNS.map((c) => csvField(c.description))

  const lines: string[] = []
  // Two-row template: header + description. No example rows — admins
  // fill in their data starting at row 3.
  lines.push(headerCells.join(","))
  lines.push(commentCells.map((c, i) => (i === 0 ? "# " + c : c)).join(","))
  // BOM for Excel UTF-8 friendliness.
  return "﻿" + lines.join("\r\n") + "\r\n"
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
