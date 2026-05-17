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
  // payroll run. The actual sync logic is not implemented yet; these
  // flags just persist the admin's preference. UI is hidden when the
  // org has no Xero connection.
  syncClaimsToXeroOnSubmit: boolean
  syncPayrollToXeroOnSubmit: boolean

  createdAt: string
  updatedAt: string
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
