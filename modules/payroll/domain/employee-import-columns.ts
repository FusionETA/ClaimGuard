/**
 * Canonical column list for the employee bulk-import template — and,
 * because it's shared, the employee EXPORT too. Keeping both on one
 * source of truth guarantees an export is directly re-importable: the
 * header row, order, and `*`-required markers always match.
 *
 * Pure data (no server-only imports) so the template route, the export
 * service, and any client that needs the header can all use it.
 */

export type EmployeeImportColumn = {
  key: string
  required: boolean
  description: string
}

// ── Identity / employment / personal / statutory / bank / hierarchy ──
// Order: everyday columns first; dependent-child columns are appended
// by `EMPLOYEE_IMPORT_COLUMNS` below.
const BASE_COLUMNS: EmployeeImportColumn[] = [
  // Identity & Employment
  { key: "name", required: true, description: "Full legal name" },
  { key: "email", required: true, description: "Login email, must be unique in the org" },
  { key: "employeeId", required: true, description: "Org-specific employee code, e.g. EMP-001" },
  { key: "jobTitle", required: true, description: "Free-text job title" },
  { key: "employeeType", required: true, description: "EMPLOYEE | SUPERVISOR — admins cannot be created via import" },
  { key: "joinDate", required: true, description: "YYYY-MM-DD; required for proration" },
  { key: "leaveDate", required: false, description: "YYYY-MM-DD — last day of employment (only if leaving)" },
  { key: "archiveReason", required: false, description: "Reason for leaving — only if leaveDate is set" },
  { key: "reportedToLhdn", required: false, description: "TRUE/FALSE — final payroll reported to LHDN" },
  // Personal & Contact
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
  { key: "phone", required: false, description: "Contact phone — at least 7 digits, or leave blank" },
  { key: "addressLine1", required: false, description: "Street address line 1" },
  { key: "addressLine2", required: false, description: "Street address line 2" },
  { key: "addressLine3", required: false, description: "Street address line 3" },
  { key: "city", required: false, description: "City" },
  { key: "postcode", required: false, description: "Postcode" },
  { key: "state", required: false, description: "State" },
  { key: "emergencyContactName", required: false, description: "Emergency contact full name" },
  { key: "emergencyContactPhone", required: false, description: "Emergency contact phone number" },
  { key: "emergencyContactRelation", required: false, description: "Parent / Spouse / Sibling / etc." },
  // Spouse
  { key: "spouseWorking", required: false, description: "TRUE/FALSE — spouse is employed" },
  { key: "spouseDisabled", required: false, description: "TRUE/FALSE — spouse is OKU / disabled" },
  { key: "spousePcbNumber", required: false, description: "Spouse's LHDN PCB number" },
  { key: "spouseIdNumber", required: false, description: "Spouse's NRIC / passport number" },
  // Statutory & Payroll
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
  { key: "socsoScheme", required: false, description: "EMPLOYMENT_INJURY_INVALIDITY | EMPLOYMENT_INJURY_ONLY — auto-derived from DOB when blank" },
  { key: "socsoNumber", required: false, description: "PERKESO number — defaults to idNumber when blank" },
  { key: "contributeToEis", required: false, description: "TRUE/FALSE — default TRUE for Malaysians" },
  { key: "contributeToSkbbk", required: false, description: "TRUE/FALSE — opt-in for SKBBK (effective Jun 2026); default FALSE" },
  { key: "ssfwNumber", required: false, description: "SSFW number — foreign workers only" },
  // Bank
  { key: "bankName", required: false, description: "e.g. Maybank, CIMB, RHB" },
  { key: "bankAccountHolderName", required: false, description: "Defaults to employee name if blank" },
  { key: "bankAccountNumber", required: false, description: "Account number" },
  { key: "paymentMethod", required: false, description: "BANK_TRANSFER | CASH | CHEQUE (default BANK_TRANSFER)" },
  // Hierarchy
  { key: "policyName", required: true, description: "Name of the employee policy in this org" },
  { key: "projectCode", required: true, description: "Project name in this org" },
  { key: "teamCode", required: true, description: "Team name within the project" },
  { key: "teamLayer", required: true, description: "Hierarchy layer (1 = bottom). Must be ≤ team.layerCount" },
]

/** Max dependent-child column groups emitted by the template/export. */
export const MAX_TEMPLATE_CHILDREN = 10

const CHILD_COLUMNS: EmployeeImportColumn[] = Array.from(
  { length: MAX_TEMPLATE_CHILDREN },
  (_, i) => i + 1,
).flatMap((n) => [
  { key: `child${n}.age`, required: false, description: `Dependent child ${n} — age in years (optional; not used in calc, kept for backward compat)` },
  { key: `child${n}.abilityStatus`, required: false, description: `Dependent child ${n} — NORMAL | DISABLED` },
  { key: `child${n}.currentlyStudying`, required: false, description: `Dependent child ${n} — UNDER_18 | PRE_UNIVERSITY | DIPLOMA_MALAYSIA | DEGREE_ABROAD` },
  { key: `child${n}.pcbDeduction`, required: false, description: `Dependent child ${n} — FULL | HALF | NONE` },
])

/** Final ordered column list: everyday columns then child columns. */
export const EMPLOYEE_IMPORT_COLUMNS: EmployeeImportColumn[] = [
  ...BASE_COLUMNS,
  ...CHILD_COLUMNS,
]

// ── Presentation metadata (labels / groups / example values) ─────────
// Drives the styled XLSX template + export. Kept as a side map so the
// canonical column list above (and the importer schema keyed by `key`)
// stay untouched. `label` is the human-readable header shown in Excel;
// the importer resolves it back to `key` via `canonicalImportKey`.

export const EMPLOYEE_IMPORT_GROUPS = [
  "Identity & Employment",
  "Personal & Contact",
  "Spouse",
  "Statutory & Payroll",
  "Bank",
  "Assignment",
  "Dependent Children",
] as const

export type EmployeeImportGroup = (typeof EMPLOYEE_IMPORT_GROUPS)[number]

type ColumnMeta = { label: string; group: EmployeeImportGroup; example?: string }

const BASE_COLUMN_META: Record<string, ColumnMeta> = {
  name: { label: "Full Name", group: "Identity & Employment", example: "Ahmad bin Abdullah" },
  email: { label: "Login Email", group: "Identity & Employment", example: "ahmad@company.com" },
  employeeId: { label: "Employee ID", group: "Identity & Employment", example: "EMP-001" },
  jobTitle: { label: "Job Title", group: "Identity & Employment", example: "Sales Executive" },
  employeeType: { label: "Employee Type", group: "Identity & Employment", example: "EMPLOYEE" },
  joinDate: { label: "Join Date", group: "Identity & Employment", example: "2024-01-15" },
  leaveDate: { label: "Leave Date", group: "Identity & Employment" },
  archiveReason: { label: "Reason for Leaving", group: "Identity & Employment" },
  reportedToLhdn: { label: "Reported to LHDN?", group: "Identity & Employment" },
  dateOfBirth: { label: "Date of Birth", group: "Personal & Contact", example: "1990-05-20" },
  gender: { label: "Gender", group: "Personal & Contact", example: "MALE" },
  race: { label: "Race (LHDN code)", group: "Personal & Contact", example: "M" },
  nationality: { label: "Nationality", group: "Personal & Contact", example: "Malaysian" },
  maritalStatus: { label: "Marital Status", group: "Personal & Contact", example: "SINGLE" },
  hasPr: { label: "Permanent Resident?", group: "Personal & Contact", example: "FALSE" },
  isResident: { label: "Tax Resident?", group: "Personal & Contact", example: "TRUE" },
  isOku: { label: "OKU (Disabled)?", group: "Personal & Contact", example: "FALSE" },
  idType: { label: "ID Type", group: "Personal & Contact", example: "NRIC" },
  idNumber: { label: "ID Number", group: "Personal & Contact", example: "900520-10-1234" },
  alternateEmail: { label: "Personal Email", group: "Personal & Contact" },
  phone: { label: "Phone", group: "Personal & Contact", example: "0123456789" },
  addressLine1: { label: "Address Line 1", group: "Personal & Contact", example: "12 Jalan Contoh" },
  addressLine2: { label: "Address Line 2", group: "Personal & Contact" },
  addressLine3: { label: "Address Line 3", group: "Personal & Contact" },
  city: { label: "City", group: "Personal & Contact", example: "Kuala Lumpur" },
  postcode: { label: "Postcode", group: "Personal & Contact", example: "50000" },
  state: { label: "State", group: "Personal & Contact", example: "Wilayah Persekutuan" },
  emergencyContactName: { label: "Emergency Contact Name", group: "Personal & Contact" },
  emergencyContactPhone: { label: "Emergency Contact Phone", group: "Personal & Contact" },
  emergencyContactRelation: { label: "Emergency Contact Relation", group: "Personal & Contact" },
  spouseWorking: { label: "Spouse Working?", group: "Spouse" },
  spouseDisabled: { label: "Spouse Disabled (OKU)?", group: "Spouse" },
  spousePcbNumber: { label: "Spouse PCB Number", group: "Spouse" },
  spouseIdNumber: { label: "Spouse ID Number", group: "Spouse" },
  salaryType: { label: "Salary Type", group: "Statutory & Payroll", example: "MONTHLY" },
  monthlySalary: { label: "Monthly Salary (MYR)", group: "Statutory & Payroll", example: "3500" },
  hourlyRate: { label: "Hourly Rate (MYR)", group: "Statutory & Payroll" },
  contributeToEpf: { label: "Contribute to EPF?", group: "Statutory & Payroll", example: "TRUE" },
  epfNumber: { label: "EPF (KWSP) Number", group: "Statutory & Payroll" },
  epfMemberBefore1998: { label: "EPF Member Before 1998?", group: "Statutory & Payroll", example: "FALSE" },
  epfEmployeeRate: { label: "Employee EPF Rate (%)", group: "Statutory & Payroll", example: "11" },
  epfEmployeeVoluntary: { label: "Voluntary Employee EPF (%)", group: "Statutory & Payroll" },
  epfEmployerVoluntary: { label: "Voluntary Employer EPF (%)", group: "Statutory & Payroll" },
  pcbBorneByEmployer: { label: "PCB Borne by Employer?", group: "Statutory & Payroll", example: "FALSE" },
  incomeTaxNumber: { label: "Income Tax (PCB) Number", group: "Statutory & Payroll" },
  socsoScheme: { label: "SOCSO Scheme", group: "Statutory & Payroll" },
  socsoNumber: { label: "SOCSO (PERKESO) Number", group: "Statutory & Payroll" },
  contributeToEis: { label: "Contribute to EIS?", group: "Statutory & Payroll", example: "TRUE" },
  contributeToSkbbk: { label: "Contribute to SKBBK?", group: "Statutory & Payroll", example: "FALSE" },
  ssfwNumber: { label: "SSFW Number", group: "Statutory & Payroll" },
  bankName: { label: "Bank Name", group: "Bank", example: "Maybank" },
  bankAccountHolderName: { label: "Bank Account Holder", group: "Bank" },
  bankAccountNumber: { label: "Bank Account Number", group: "Bank", example: "1234567890" },
  paymentMethod: { label: "Payment Method", group: "Bank", example: "BANK_TRANSFER" },
  policyName: { label: "Leave / Attendance Policy", group: "Assignment", example: "Default Policy" },
  projectCode: { label: "Project", group: "Assignment", example: "HQ" },
  teamCode: { label: "Team", group: "Assignment", example: "Sales Team" },
  teamLayer: { label: "Team Layer", group: "Assignment", example: "1" },
}

const CHILD_SUBFIELD_LABEL: Record<string, string> = {
  age: "Age",
  abilityStatus: "Ability (NORMAL / DISABLED)",
  currentlyStudying: "Study Level",
  pcbDeduction: "PCB Claim (FULL / HALF / NONE)",
}

function childMeta(key: string): ColumnMeta | null {
  const m = key.match(/^child(\d+)\.(\w+)$/)
  if (!m) return null
  const subLabel = CHILD_SUBFIELD_LABEL[m[2]] ?? m[2]
  return { label: `Child ${m[1]} — ${subLabel}`, group: "Dependent Children" }
}

/** Presentation metadata for a column key (falls back to the raw key). */
export function columnMeta(key: string): ColumnMeta {
  return (
    BASE_COLUMN_META[key] ??
    childMeta(key) ?? { label: key, group: "Identity & Employment" }
  )
}
export function columnLabel(key: string): string {
  return columnMeta(key).label
}
export function columnGroup(key: string): EmployeeImportGroup {
  return columnMeta(key).group
}

function normaliseHeader(h: string): string {
  return h.trim().replace(/^\*/, "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

// normalise(key OR friendly label) → canonical key. Built once at load.
const HEADER_ALIAS: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const col of EMPLOYEE_IMPORT_COLUMNS) {
    map.set(normaliseHeader(col.key), col.key)
    map.set(normaliseHeader(columnLabel(col.key)), col.key)
  }
  return map
})()

/**
 * Resolve a header cell (from the XLSX template, the CSV export, or a
 * legacy key-based CSV) to its canonical import key. Accepts BOTH the
 * machine key (`monthlySalary`) and the friendly label
 * (`Monthly Salary (MYR)`), case/spacing/punctuation-insensitive. An
 * unknown header passes through (just `*`-stripped) so the importer
 * keeps ignoring columns it doesn't recognise.
 */
export function canonicalImportKey(header: string): string {
  return HEADER_ALIAS.get(normaliseHeader(header)) ?? header.trim().replace(/^\*/, "")
}
