/**
 * Domain types for the payroll module.
 *
 * These are server+client-safe types (no Prisma imports). Repos /
 * services project Prisma rows into these shapes before returning to
 * pages so the UI layer never sees Prisma `Decimal` wrappers or
 * `JsonValue` opaque types.
 */

// ─── Enums (re-exported from Prisma but typed locally so UIs don't
// pull Prisma into client bundles) ────────────────────────────────────────

export const genders = ["MALE", "FEMALE"] as const
export type Gender = (typeof genders)[number]

export const idTypes = ["NRIC", "PASSPORT", "ARMY_NO", "POLICE_NO"] as const
export type IdType = (typeof idTypes)[number]

export const maritalStatuses = [
  "SINGLE",
  "MARRIED",
  "DIVORCED",
  "WIDOWED",
] as const
export type MaritalStatus = (typeof maritalStatuses)[number]

export const socsoSchemes = [
  "EMPLOYMENT_INJURY_INVALIDITY",
  "EMPLOYMENT_INJURY_ONLY",
] as const
export type SocsoScheme = (typeof socsoSchemes)[number]

export const salaryTypes = ["MONTHLY", "HOURLY"] as const
export type SalaryType = (typeof salaryTypes)[number]

export const paymentMethods = ["BANK_TRANSFER", "CASH", "CHEQUE"] as const
export type PaymentMethod = (typeof paymentMethods)[number]

// Human-readable labels for the dropdowns.
export const SOCSO_SCHEME_LABELS: Record<SocsoScheme, string> = {
  EMPLOYMENT_INJURY_INVALIDITY: "Employment Injury & Invalidity Scheme",
  EMPLOYMENT_INJURY_ONLY: "Employment Injury Scheme only",
}
export const ID_TYPE_LABELS: Record<IdType, string> = {
  NRIC: "NRIC",
  PASSPORT: "Passport",
  ARMY_NO: "Army No.",
  POLICE_NO: "Police No.",
}
export const MARITAL_STATUS_LABELS: Record<MaritalStatus, string> = {
  SINGLE: "Single",
  MARRIED: "Married",
  DIVORCED: "Divorced",
  WIDOWED: "Widowed",
}
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  BANK_TRANSFER: "Bank transfer",
  CASH: "Cash",
  CHEQUE: "Cheque",
}
export const SALARY_TYPE_LABELS: Record<SalaryType, string> = {
  MONTHLY: "Monthly",
  HOURLY: "Hourly",
}

// ─── Child relief JSON shape (stored as Json on PayrollProfile) ──────────

export const childAbilityStatuses = ["NORMAL", "DISABLED"] as const
export type ChildAbilityStatus = (typeof childAbilityStatuses)[number]

export const childStudyingLevels = [
  "NONE",
  "PRESCHOOL",
  "PRIMARY",
  "SECONDARY",
  "HIGHER_ED",
] as const
export type ChildStudyingLevel = (typeof childStudyingLevels)[number]

export const childPcbDeductionLevels = ["FULL", "HALF", "NONE"] as const
export type ChildPcbDeductionLevel = (typeof childPcbDeductionLevels)[number]

/**
 * One child entry. Up to 4 children supported in the PayrollPanda
 * template; we store as an array so the count is flexible.
 */
export type ChildRelief = {
  age: number
  abilityStatus: ChildAbilityStatus
  currentlyStudying: ChildStudyingLevel
  /// What share of the PCB relief is claimed for this child. Required
  /// when claiming relief; defaults to "NONE" when the child isn't
  /// eligible.
  pcbDeduction: ChildPcbDeductionLevel
}

// ─── Fixed allowance JSON shape ──────────────────────────────────────────

/**
 * Recurring per-month allowance applied to every payroll run for an
 * employee. Compared to a PayslipLineItem (which is per-payslip), this
 * is the "template" version that auto-creates ALLOWANCE line items on
 * each new run.
 */
export type FixedAllowance = {
  name: string
  amount: number
}

// ─── Leave entitlement JSON shape (v2 placeholder) ───────────────────────

export type LeaveEntitlement = {
  type: string // e.g. "ANNUAL" | "SICK" — to be enum'd when leave module ships
  days: number
}

// ─── PayrollProfile — the projected view returned by services ───────────

/**
 * Projected shape of a PayrollProfile after Prisma row → app-friendly
 * conversion. All Decimals are numbers, all JSON columns are typed.
 *
 * Used by both the admin "edit employee payroll profile" form and any
 * read-only consumer.
 */
export type PayrollProfileData = {
  id: string
  employeeProfileId: string

  // Personal
  phone: string | null
  alternateEmail: string | null
  gender: Gender | null
  dateOfBirth: string | null // ISO yyyy-mm-dd
  nationality: string | null
  race: string | null
  hasPr: boolean
  idType: IdType | null
  idNumber: string | null
  maritalStatus: MaritalStatus | null
  isResident: boolean
  isOku: boolean

  // Spouse
  spouseWorking: boolean | null
  spouseDisabled: boolean | null
  spousePcbNumber: string | null
  spouseIdNumber: string | null

  // Address
  addressLine1: string | null
  addressLine2: string | null
  addressLine3: string | null
  city: string | null
  postcode: string | null
  state: string | null

  // Emergency contact
  emergencyContactName: string | null
  emergencyContactPhone: string | null
  emergencyContactRelation: string | null

  // Children (parsed JSON; up to N entries)
  childRelief: ChildRelief[]

  // Previous employment (for v2 TP3 carryover)
  prevEmploymentYear: number | null
  prevRemuneration: number | null
  prevEpf: number | null

  // EPF
  contributeToEpf: boolean
  epfMemberBefore1998: boolean
  epfNumber: string | null
  epfEmployeeRate: number
  epfEmployeeVoluntary: number
  epfEmployerVoluntary: number

  // SOCSO / EIS / PCB
  socsoNumber: string | null
  socsoScheme: SocsoScheme | null
  contributeToEis: boolean
  incomeTaxNumber: string | null
  pcbBorneByEmployer: boolean
  ssfwNumber: string | null

  // Payment
  paymentMethod: PaymentMethod
  bankName: string | null
  bankAccountHolderName: string | null
  bankAccountNumber: string | null

  // Compensation
  salaryType: SalaryType
  monthlySalary: number | null
  hourlyRate: number | null
  fixedAllowances: FixedAllowance[]

  // Employment dates
  joinDate: string | null // ISO yyyy-mm-dd
  leaveDate: string | null
  archiveReason: string | null
  reportedToLhdn: boolean

  // Grouping
  department: string | null
  location: string | null
  workSchedule: string | null
  payrollPolicy: string | null
  payrollCycle: string | null

  // Leave (v2 placeholder)
  leaveEntitlement: LeaveEntitlement[]

  // Status
  isArchived: boolean
  archivedAt: string | null // ISO datetime

  createdAt: string // ISO datetime
  updatedAt: string
}

/**
 * "Employee with payroll context" — the row shape for the payroll
 * employees list page. Combines basic user info from `EmployeeProfile`
 * with completion flags from `PayrollProfile`.
 */
export type PayrollEmployeeRow = {
  /// User.id (used as the route param /admin/payroll/employees/[id]).
  userId: string
  employeeProfileId: string
  /// Org-specific employee code (e.g. "EMP-001").
  employeeId: string
  name: string
  email: string
  jobTitle: string
  /// True if a PayrollProfile row exists for this employee at all.
  hasProfile: boolean
  /// True only when every required statutory + compensation field is filled
  /// in. Drives the "incomplete" visual indicator on the list page.
  isComplete: boolean
  /// True when the profile is archived. Archived rows are still shown on
  /// the list (greyed out) so admin can un-archive.
  isArchived: boolean
}

// ─── Completion check ─────────────────────────────────────────────────────

/**
 * Pure helper: decide whether a payroll profile has all the fields
 * needed to run payroll. Used by the list page to show a ✓ vs warning.
 *
 * Required for v1 payroll calc:
 *   - salaryType + matching salary field
 *   - join date
 *   - EPF rate (always defaulted, so never undefined — checked anyway)
 *   - if EPF contribution enabled: EPF number
 *   - if SOCSO contribution: scheme + number
 *   - PCB / income tax number (required for any future PCB calc)
 *
 * Bank info is NOT required to run a payroll calc — it's only needed
 * to actually disburse. So we don't gate completeness on it.
 */
export function isPayrollProfileComplete(p: PayrollProfileData): boolean {
  // Compensation: must have a salary value for the chosen type.
  if (p.salaryType === "MONTHLY" && (p.monthlySalary == null || p.monthlySalary <= 0)) {
    return false
  }
  if (p.salaryType === "HOURLY" && (p.hourlyRate == null || p.hourlyRate <= 0)) {
    return false
  }

  // Must have a join date for proration.
  if (!p.joinDate) return false

  // EPF: number required if contributing.
  if (p.contributeToEpf && !p.epfNumber) return false

  // SOCSO: scheme + number required if a SOCSO scheme is set at all.
  // (We treat an unset scheme as "not contributing" which is allowed
  // for foreign workers etc.)
  if (p.socsoScheme && !p.socsoNumber) return false

  // Income tax number — required for any LHDN filing.
  if (!p.incomeTaxNumber) return false

  return true
}
