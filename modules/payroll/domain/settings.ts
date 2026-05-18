/**
 * Projected types for the per-org payroll settings tables.
 *
 * Split into TWO records because they map to two different concerns:
 *   - `PayrollSettingsData`   — operational rules (OT, EPF defaults, etc.)
 *   - `PayrollCompanyInfoData` — employer filing identity (Form E)
 *
 * Each saves independently, but the settings page renders them in one
 * tabbed UI for convenience.
 */

import type { IdType } from "@/modules/payroll/domain/models"

// ─── Enums (re-exported as const arrays for form pickers) ────────────────

export const workingDaysRules = ["CALENDAR", "TWENTY_SIX"] as const
export type WorkingDaysRule = (typeof workingDaysRules)[number]

export const WORKING_DAYS_RULE_LABELS: Record<WorkingDaysRule, string> = {
  CALENDAR: "Calendar days in month",
  TWENTY_SIX: "26 days (Malaysian convention)",
}

// ─── PayrollSettings (per-org operational rules) ─────────────────────────

export type PayrollSettingsData = {
  id: string
  organizationId: string

  // OT multipliers were removed — they now live on EmployeePolicy
  // (one set of rates per policy, only applied when otMethod = CASH).

  // Working-days rule for proration + hourly conversion
  workingDaysRule: WorkingDaysRule

  // EPF defaults (overridable per-employee on PayrollProfile)
  defaultEpfEmployeeRate: number
  defaultEpfEmployerRate: number

  // HRDF (HRD Corp levy) — Malaysian citizens only per PSMB Act 2001.
  hrdfEnabled: boolean
  hrdfRate: number | null

  // PCB — auto-apply the RM 350/year combined SOCSO + EIS contribution
  // relief inside the monthly PCB calc. Default ON. When OFF the
  // relief is treated as a TP1 item.
  autoApplySocsoEisRelief: boolean

  // Employer identifiers
  employerIdNumber: string | null
  myCoOrSsmNumber: string | null

  // Leave carry-forward — placeholders for the upcoming leave module.
  leaveCarryForwardAllowed: boolean
  leaveCarryForwardLimitDays: number | null
  leaveCarryForwardExpiryMonths: number | null

  // Xero sync — opt-in toggles that fire when the admin submits a
  // payroll run. UI is hidden when the org has no Xero connection.
  syncClaimsToXeroOnSubmit: boolean
  syncPayrollToXeroOnSubmit: boolean

  // Xero sync configuration — see `PayrollXeroMapping` for shape.
  // `null` when the admin hasn't configured Xero yet.
  xeroMapping: PayrollXeroMapping | null

  createdAt: string
  updatedAt: string
}

// ─── Xero sync mapping ──────────────────────────────────────────────────

/**
 * Controls how the manual journal generated for each PayrollRun lays
 * out its expense (debit) lines.
 *
 *   - `PER_EMPLOYEE`   — one line per (employee × category). Matches
 *                       the example journal Simon shared on 2026-05-18
 *                       (SALARY - JACYLYN WEE SU-YIN, SALARY - PREM
 *                       KAUR A/P CHANAN SINGH, …).
 *   - `SUM_BY_PROJECT` — one line per (project × category). Useful
 *                       for orgs that want a tidier P&L grouped by
 *                       project rather than employee.
 *
 * Accruals are ALWAYS summed regardless of this setting.
 */
export const xeroAggregationModes = [
  "PER_EMPLOYEE",
  "SUM_BY_PROJECT",
] as const
export type XeroAggregationMode = (typeof xeroAggregationModes)[number]

export const XERO_AGGREGATION_MODE_LABELS: Record<XeroAggregationMode, string> = {
  PER_EMPLOYEE: "One line per employee",
  SUM_BY_PROJECT: "Sum by project",
}

/**
 * Payroll category keys whose Xero Chart-of-Accounts target the admin
 * configures in settings. Used as both the JSON key in the saved blob
 * and the i18n / form key in the settings UI.
 *
 * Grouped by where they appear on the manual journal:
 *   - core expense (debit)
 *   - accrual (credit, always summed)
 *   - optional extras (debit, only when the run has these line types)
 */
export const PAYROLL_XERO_ACCOUNT_KEYS = [
  // ── Core expenses (debit) ──
  "salary",
  "allowance",
  "directorSalary",
  "directorFee",
  "epfEmployer",
  "socsoEmployer",
  "eisEmployer",
  "hrdfEmployer",
  // ── Accruals (credit, always summed) ──
  "accrualEpf",
  "accrualSocso",
  "accrualEis",
  "accrualPcb",
  "accrualSalary",
  // ── Optional extras (debit) ──
  "bonus",
  "commission",
  "overtime",
] as const
export type PayrollXeroAccountKey = (typeof PAYROLL_XERO_ACCOUNT_KEYS)[number]

/**
 * Grouped key sets for rendering the settings form. Order matches
 * what the admin will see in the UI top-to-bottom.
 */
export const PAYROLL_XERO_ACCOUNT_GROUPS: Array<{
  title: string
  description: string
  keys: PayrollXeroAccountKey[]
}> = [
  {
    title: "Expense accounts",
    description:
      "Debit side of the manual journal. Charged to your P&L when payroll posts.",
    keys: [
      "salary",
      "allowance",
      "directorSalary",
      "directorFee",
      "epfEmployer",
      "socsoEmployer",
      "eisEmployer",
      "hrdfEmployer",
    ],
  },
  {
    title: "Accrual accounts",
    description:
      "Credit side. Always one summed line per category regardless of aggregation mode.",
    keys: [
      "accrualEpf",
      "accrualSocso",
      "accrualEis",
      "accrualPcb",
      "accrualSalary",
    ],
  },
  {
    title: "Optional extras",
    description:
      "Only used when a payroll run carries these line types. Leave blank to fall back to the Salary account.",
    keys: ["bonus", "commission", "overtime"],
  },
]

/**
 * Human-readable labels for each account key. Surfaced as the field
 * label in the settings form.
 */
export const PAYROLL_XERO_ACCOUNT_LABELS: Record<
  PayrollXeroAccountKey,
  string
> = {
  salary: "Salary",
  allowance: "Allowance",
  directorSalary: "Director salary",
  directorFee: "Director fee",
  epfEmployer: "EPF — employer contribution",
  socsoEmployer: "SOCSO — employer contribution",
  eisEmployer: "EIS — employer contribution",
  hrdfEmployer: "HRDF — employer levy",
  accrualEpf: "Accrual — EPF (employee + employer)",
  accrualSocso: "Accrual — SOCSO",
  accrualEis: "Accrual — EIS",
  accrualPcb: "Accrual — PCB (employee tax)",
  accrualSalary: "Accrual — net salary payable",
  bonus: "Bonus",
  commission: "Commission",
  overtime: "Overtime",
}

/**
 * Full Xero mapping persisted as JSON on `PayrollSettings.xeroMapping`.
 *
 * All fields except the schema-version `v` are nullable so the admin
 * can partially configure: e.g. set the tracking category + a few
 * accounts and finish later. The sync paths refuse to fire until
 * every CORE expense + accrual account is set (extras stay optional
 * and fall back to the salary account).
 */
export type PayrollXeroMapping = {
  /// Schema version. Bump when the shape changes — the loader uses
  /// this to migrate or ignore older blobs gracefully.
  v: 1
  aggregationMode: XeroAggregationMode
  /// Xero tracking-category ID. The project name fills the option
  /// slot on every line. `null` means the admin hasn't picked one
  /// yet (UI surfaces a prompt).
  trackingCategoryId: string | null
  /// Xero account ID per payroll category. `null` for any key the
  /// admin hasn't picked yet.
  accounts: Partial<Record<PayrollXeroAccountKey, string | null>>
}

/**
 * Default mapping used when `PayrollSettings.xeroMapping` is null on
 * a fresh save. The form starts with PER_EMPLOYEE aggregation and
 * everything else empty — admin fills in as they go.
 */
export const DEFAULT_PAYROLL_XERO_MAPPING: PayrollXeroMapping = {
  v: 1,
  aggregationMode: "PER_EMPLOYEE",
  trackingCategoryId: null,
  accounts: {},
}

// ─── PayrollCompanyInfo (per-org employer filing identity) ───────────────

export type PayrollCompanyInfoData = {
  id: string
  organizationId: string

  // Employer basic particulars (Form E)
  employerName: string | null
  employerTin: string | null
  registrationNo: string | null
  referenceType: string | null
  referenceNo: string | null
  employerCategory: string | null
  employerStatus: string | null
  cp8dFurnishType: string | null

  // Correspondence
  addressLine1: string | null
  addressLine2: string | null
  postcode: string | null
  city: string | null
  state: string | null
  country: string
  phone: string | null
  handphone: string | null
  email: string | null

  // Tax agent
  taxAgentName: string | null
  taxAgentTin: string | null
  taxAgentLicenceNo: string | null
  taxAgentPhone: string | null
  taxAgentEmail: string | null
  taxAgentFirmName: string | null
  taxAgentFirmAddressLine1: string | null
  taxAgentFirmAddressLine2: string | null
  taxAgentFirmPostcode: string | null
  taxAgentFirmCity: string | null
  taxAgentFirmState: string | null

  // Declarant
  declarantName: string | null
  declarantIdType: IdType | null
  declarantIdNumber: string | null
  declarantPosition: string | null

  createdAt: string
  updatedAt: string
}

// ─── Curated dropdowns for Form E (matches LHDN's published values) ──────

/**
 * Reference type codes — Form E "Reference No." prefix. These are the
 * LHDN-recognised codes; we list the curated set used by the settings
 * dropdown.
 */
export const REFERENCE_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "01 - SG", label: "01 - SG (Individual non-business)" },
  { value: "02 - OG", label: "02 - OG (Individual business)" },
  { value: "03 - C", label: "03 - C (Company)" },
  { value: "04 - D", label: "04 - D (Partnership)" },
  { value: "05 - F", label: "05 - F (Co-operative society)" },
  { value: "06 - TR", label: "06 - TR (Trust body)" },
  { value: "07 - LE", label: "07 - LE (Limited liability partnership)" },
]

export const EMPLOYER_CATEGORY_OPTIONS: Array<{
  value: string
  label: string
}> = [
  { value: "1 - Statutory Body", label: "1 - Statutory Body" },
  { value: "2 - Government Department", label: "2 - Government Department" },
  { value: "3 - Local Authority", label: "3 - Local Authority" },
  { value: "4 - Public Sector (Other)", label: "4 - Public Sector (Other)" },
  {
    value: "5 - Private Sector (Other than Company)",
    label: "5 - Private Sector (Other than Company)",
  },
  { value: "6 - Company", label: "6 - Company" },
]

export const EMPLOYER_STATUS_OPTIONS: Array<{
  value: string
  label: string
}> = [
  { value: "1 - In Operation", label: "1 - In Operation" },
  { value: "2 - Dormant", label: "2 - Dormant" },
  { value: "3 - In Receivership", label: "3 - In Receivership" },
  { value: "4 - In Liquidation", label: "4 - In Liquidation" },
  { value: "5 - Dissolved", label: "5 - Dissolved" },
]

export const CP8D_FURNISH_TYPE_OPTIONS: Array<{
  value: string
  label: string
}> = [
  {
    value: "1 - Via e-Data Praisi / e-CP8D",
    label: "1 - Via e-Data Praisi / e-CP8D",
  },
  { value: "2 - Via paper form", label: "2 - Via paper form" },
]
