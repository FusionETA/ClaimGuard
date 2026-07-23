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

import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  payrollAdjustmentCategories,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"
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

  // NB: PayrollSettings used to also expose `employerIdNumber` (LHDN
  // E No.) and `myCoOrSsmNumber` (SSM) here, but those duplicated the
  // canonical fields on PayrollCompanyInfo (`employerTin` and
  // `registrationNo`) — which every statutory generator already reads
  // from. The duplicates were dropped from the TS layer; the DB
  // columns are left in place (no migration) until they're confirmed
  // safe to drop.

  // Xero sync — opt-in toggles that fire when the admin submits a
  // payroll run. UI is hidden when the org has no Xero connection.
  syncClaimsToXeroOnSubmit: boolean
  syncPayrollToXeroOnSubmit: boolean

  // Xero sync configuration — see `PayrollXeroMapping` for shape.
  // `null` when the admin hasn't configured Xero yet.
  xeroMapping: PayrollXeroMapping | null

  // Bank disbursement — Public Bank ECP Payroll bulk-upload config.
  // `ecpPayorAccountNo` is the 10-digit Public Bank debiting account
  // the salary is paid FROM; `ecpPayorBic` defaults to PBBEMYKL when
  // null (Public Bank).
  ecpPayorAccountNo: string | null
  ecpPayorBic: string | null

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
  "epfEmployer",
  "socsoEmployer",
  "eisEmployer",
  "hrdfEmployer",
  // ── Accruals (credit, always summed) ──
  "accrualEpf",
  "accrualSocso",
  "accrualEis",
  "accrualSkbbk",
  "accrualPcb",
  "accrualHrdf",
  "accrualSalary",
  // ── Generic deduction account (used in UNIFIED deduction mode) ──
  "deduction",
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
    // The unified allowance account is configured in the dedicated
    // "Allowance accounts" card below (which sets `account.allowance`
    // in unified mode), so it's intentionally not repeated here.
    keys: [
      "salary",
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
      "accrualSkbbk",
      "accrualPcb",
      "accrualHrdf",
      "accrualSalary",
    ],
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
  allowance: "Allowance (unified mode)",
  epfEmployer: "EPF — employer contribution",
  socsoEmployer: "SOCSO — employer contribution",
  eisEmployer: "EIS — employer contribution",
  hrdfEmployer: "HRDF — employer levy",
  accrualEpf: "Accrual — EPF (employee + employer)",
  accrualSocso: "Accrual — SOCSO",
  accrualEis: "Accrual — EIS",
  accrualSkbbk: "Accrual — SKBBK (Skim LINDUNG 24 Jam)",
  accrualPcb: "Accrual — PCB (employee tax)",
  accrualHrdf: "Accrual — HRDF (HRD Corp levy payable)",
  accrualSalary: "Accrual — net salary payable",
  deduction: "Deduction (unified mode)",
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
/**
 * Mode toggle for the Allowance / Deduction cards:
 *   - `UNIFIED`      — every allowance (or deduction) line posts to
 *                      one configured COA. Simple, one dropdown to
 *                      maintain.
 *   - `PER_CATEGORY` — each PayrollAdjustmentCategory maps to its
 *                      own COA via the `*AccountsByCategory` map.
 *                      Cleaner P&L; the sync refuses to post if any
 *                      category appearing on a payslip isn't mapped.
 */
export const xeroLineGroupingModes = ["UNIFIED", "PER_CATEGORY"] as const
export type XeroLineGroupingMode = (typeof xeroLineGroupingModes)[number]

export type PayrollXeroMapping = {
  /// Schema version. Bump when the shape changes — the loader uses
  /// this to migrate or ignore older blobs gracefully.
  /// v1 = legacy (single allowance + bonus/commission/overtime keys).
  /// v2 = allowance + deduction mode toggles with per-category maps.
  v: 2
  aggregationMode: XeroAggregationMode
  /// Xero tracking-category ID. The project name fills the option
  /// slot on every line. `null` means the admin hasn't picked one
  /// yet (UI surfaces a prompt).
  trackingCategoryId: string | null
  /// Xero account ID per top-level payroll category. `null` for any
  /// key the admin hasn't picked yet.
  accounts: Partial<Record<PayrollXeroAccountKey, string | null>>
  /// How to map allowance line items to Xero accounts.
  ///   - UNIFIED       → use `accounts.allowance` for every allowance.
  ///   - PER_CATEGORY  → use `allowanceAccounts[<category>]`.
  allowanceMode: XeroLineGroupingMode
  /// Per-category allowance account IDs. Only consumed when
  /// `allowanceMode === "PER_CATEGORY"`. Keys are
  /// `PayrollAdjustmentCategory` codes (e.g. `allowance_meal`,
  /// `wages_bonus_annual`, `bik_car`). Persisted even in UNIFIED mode
  /// so flipping the toggle back doesn't lose the admin's picks.
  allowanceAccounts: Record<string, string | null>
  /// How to map deduction line items.
  deductionMode: XeroLineGroupingMode
  /// Per-category deduction account IDs. Same shape as
  /// allowanceAccounts but with deduction-flavour category keys
  /// (`deduct_unpaid_leave`, `deduct_salary_adjustment`,
  /// `deduct_advance`).
  deductionAccounts: Record<string, string | null>
}

/**
 * Default mapping used when `PayrollSettings.xeroMapping` is null on
 * a fresh save. The form starts with PER_EMPLOYEE aggregation,
 * UNIFIED mode for both allowances and deductions, and everything
 * else empty — admin fills in as they go.
 */
export const DEFAULT_PAYROLL_XERO_MAPPING: PayrollXeroMapping = {
  v: 2,
  // Sum-by-project is the only live aggregation mode today (per-employee
  // is flagged "upcoming" and disabled in the settings picker), so new
  // mappings default to it — otherwise the picker would open showing the
  // disabled per-employee option as the current value.
  aggregationMode: "SUM_BY_PROJECT",
  trackingCategoryId: null,
  accounts: {},
  allowanceMode: "UNIFIED",
  allowanceAccounts: {},
  deductionMode: "UNIFIED",
  deductionAccounts: {},
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

  // PERKESO/SOCSO employer code — feeds the SOCSO+EIS TXT employer
  // code column. Separate from the LHDN referenceNo above.
  perkesoEmployerCode: string | null

  // KWSP (EPF) employer registration number. Feeds the EPF CSV upload
  // header. Every statutory body issues its own number — this is
  // separate from employerTin (LHDN E) and perkesoEmployerCode (SOCSO).
  epfEmployerNo: string | null

  // HRD Corp levy employer registration number. Only relevant when
  // the org is HRDF-registered (Part I or Part II under PSMB Act 2001).
  hrdfEmployerNo: string | null

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

// ─── Required-field gate (shared by readiness service + settings tab) ────

/**
 * The PayrollCompanyInfoData fields that MUST be filled before a
 * payroll run can be submitted for approval. Single source of truth
 * for both the pre-submit readiness service (which blocks the submit)
 * and the Form E tab pill in the settings UI (which shows red until
 * these are filled) — so the two indicators can never disagree.
 *
 * Why these four:
 *   - employerName       → every statutory document header
 *   - employerTin        → PCB TXT, EPF CSV, CP8D, EA
 *   - registrationNo     → SOCSO+EIS TXT, CP8D
 *   - perkesoEmployerCode → SOCSO+EIS TXT employer code column
 *
 * Other Form E fields (correspondence address, declarant, tax agent,
 * CP8D furnish type) are required at YEAR-END Form E generation time,
 * not at monthly payroll submit, so they're not gated here.
 */
export const PAYROLL_REQUIRED_COMPANY_INFO_FIELDS = [
  { key: "employerName", label: "Employer name" },
  { key: "employerTin", label: "Employer No. (LHDN E No.)" },
  { key: "registrationNo", label: "Registration No. (SSM / MyCoID)" },
  { key: "perkesoEmployerCode", label: "PERKESO Employer Code" },
] as const satisfies ReadonlyArray<{
  key: keyof PayrollCompanyInfoData
  label: string
}>

/**
 * Pure helper — true when every `PAYROLL_REQUIRED_COMPANY_INFO_FIELDS`
 * field is non-blank on the given company info. Drives the Form E tab
 * pill colour in the settings UI.
 */
export function isCompanyInfoReadyForPayroll(
  companyInfo: PayrollCompanyInfoData | null,
): boolean {
  if (!companyInfo) return false
  return PAYROLL_REQUIRED_COMPANY_INFO_FIELDS.every((f) => {
    const v = companyInfo[f.key]
    return typeof v === "string" && v.trim().length > 0
  })
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

// ─── Allowance / Deduction category groupings for Xero mapping ──────────
//
// Both the settings UI and the journal builder need a stable list of
// categories per card. Allowances cover everything that lands on the
// debit side that isn't already mapped via the core expense keys
// (salary, director salary, employer contributions). Deductions
// cover the admin-controlled deductions only — statutory deductions
// (PCB, Zakat, CP38, TP1) already post via the accrualPcb account
// and aren't re-mapped here.

export const PAYROLL_XERO_ALLOWANCE_CATEGORIES: PayrollAdjustmentCategory[] =
  payrollAdjustmentCategories.filter(
    (cat) => PAYROLL_ADJUSTMENT_CATEGORY_META[cat].kind === "ALLOWANCE",
  )

// `deduct_unpaid_leave` is intentionally NOT in this list — the Xero
// sync nets unpaid leave into the SALARY Dr line at source, so it
// doesn't need (or use) a per-category COA mapping.
export const PAYROLL_XERO_DEDUCTION_CATEGORIES: PayrollAdjustmentCategory[] = [
  "deduct_salary_adjustment",
  "deduct_advance",
]

export function getPayrollAdjustmentLabel(
  cat: PayrollAdjustmentCategory,
): string {
  return PAYROLL_ADJUSTMENT_CATEGORY_META[cat]?.label ?? cat
}

export function getPayrollAdjustmentGroup(
  cat: PayrollAdjustmentCategory,
): string {
  return PAYROLL_ADJUSTMENT_CATEGORY_META[cat]?.group ?? ""
}
