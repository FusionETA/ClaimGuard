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
