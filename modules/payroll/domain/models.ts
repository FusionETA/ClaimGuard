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
// Zakat-on-income (zakat pendapatan) is handled entirely through the
// monthly deduction categories — there is no separate per-employee
// zakat method or eligibility setting:
//   - `deduct_zakat`      (PZB) — reduces take-home AND offsets PCB.
//   - `deduct_zakat_tp1`  (TP1) — offsets PCB only (self-paid; cashNeutral).

/**
 * Employee types accepted by the bulk import. Subset of `UserRole`
 * minus `ADMIN` — admins are created via the admin UI only, never
 * through a CSV import.
 */
export const importableEmployeeTypes = ["EMPLOYEE", "SUPERVISOR"] as const
export type ImportableEmployeeType = (typeof importableEmployeeTypes)[number]

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

// ─── Fixed adjustment JSON shape ─────────────────────────────────────────

export const payrollAdjustmentCategories = [
  "allowance_standard",
  "allowance_travel_official",
  "allowance_travel_private",
  "allowance_parking",
  "allowance_meal",
  "allowance_childcare",
  "allowance_phone_bill",
  "allowance_phone_fixed",
  "wages_bonus_annual",
  "wages_bonus_non_annual",
  "wages_commission",
  "wages_incentive",
  "wages_arrears",
  "wages_overtime",
  "wages_service_charge",
  "wages_leave_pay",
  "wages_gratuity",
  "wages_compensation_loss_employment",
  "wages_ex_gratia",
  "wages_tax_borne_by_employer",
  "wages_director_fee",
  "wages_expense_claim",
  "bik_car",
  "bik_medical",
  "bik_award",
  "bik_living_accommodation",
  "bik_share_scheme",
  "bik_subsidised_loan",
  "bik_phone_pda_gift",
  "bik_other_exempt",
  "deduct_unpaid_leave",
  "deduct_salary_adjustment",
  "deduct_advance",
  "deduct_cp38",
  "deduct_zakat",
  "deduct_zakat_tp1",
  "deduct_tp1",
] as const
export type PayrollAdjustmentCategory =
  (typeof payrollAdjustmentCategories)[number]

export type PayrollAdjustmentCategoryMeta = {
  code: PayrollAdjustmentCategory
  label: string
  group: "Allowances / Recurring Monthly" | "Remuneration" | "Benefits-in-kind / Perquisites" | "Deductions"
  kind: "ALLOWANCE" | "DEDUCTION" | "REIMBURSEMENT"
  subjectToEpf: boolean
  subjectToSocso: boolean
  subjectToEis: boolean
  subjectToPcb: boolean
  /// Whether this row contributes to the HRD Corp levy wage base.
  /// Per PSMB Act 2001 § 2, the levy "wages" = basic salary + fixed
  /// allowances of a like nature + leave pay + arrears, and
  /// EXCLUDES travel allowance, special-expense reimbursements,
  /// gratuity, bonus, commission, and apprentice allowances. Default
  /// true is applied at the calc site for rows that omit this
  /// field — but ALL categories in this file set it explicitly to
  /// keep the audit trail traceable.
  subjectToHrdf: boolean
  /// Annual ceiling (in RM) up to which the line item is tax-exempt.
  /// Anything above this YTD threshold contributes to the PCB base
  /// even if the row is normally `subjectToPcb: true`. Implemented in
  /// `calcPayslip` via `ytdAllowanceByCategory` — see calc.ts.
  taxExemptLimit?: number
  reducesBase?: boolean
  /// When true, this deduction reduces GROSS pay (it represents lost
  /// earnings, e.g. unpaid leave), not just take-home. The amount is
  /// subtracted from gross and is NOT also counted in
  /// `totalDeductions` (which would double-reduce net). The base-salary
  /// line still shows the full salary, with this as a separate "−X" line.
  reducesGross?: boolean
  /// When true, this line's amount is NOT multiplied by the join/leave
  /// proration factor in `calcPayslip`. Unpaid leave is already computed
  /// at the full daily rate (monthlySalary ÷ divisor × unpaid days), so
  /// re-prorating it would under-deduct for a late joiner/leaver.
  skipProration?: boolean
  referenceOnly?: boolean
  /// When true, the amount is treated as additional remuneration
  /// under LHDN's PCB MTD spec — a one-off payment (bonus,
  /// commission, arrears, director fee, gratuity, etc.) that should
  /// NOT be projected forward across the remaining months. The PCB
  /// orchestrator applies the AR-specific formula:
  ///   PCB_AR = tax(chargeable_with_AR) - tax(chargeable_normal)
  /// which is the tax delta of adding the AR to annual chargeable
  /// income, without inflating the recurring monthly projection.
  isAdditionalRemuneration?: boolean
  /// When true, deducting this line item also lowers the PCB owed
  /// for the month (capped at the PCB amount). Currently used by
  /// zakat — see `calcPayslip`.
  offsetsPcb?: boolean
  /// When true, this line offsets PCB (see `offsetsPcb`) but is NOT
  /// subtracted from take-home pay. Models zakat the employee paid
  /// OUTSIDE payroll (declared via Borang TP1 §D1(a)): the employer
  /// must lower that month's PCB, but must not deduct anything from
  /// the payslip because the employee already paid it directly to the
  /// zakat centre. `calcPayslip` adds it to the PCB-offset bucket but
  /// skips `totalRecurringDeductions`.
  cashNeutral?: boolean
  /// When true, this line is the value of a non-cash benefit (BIK /
  /// perquisite). It DOES NOT contribute to gross / net pay because
  /// the employee never receives the amount in cash — the employer
  /// pays it out elsewhere (rent for accommodation, lease for company
  /// car, etc.) But it DOES contribute to the PCB taxable income
  /// base when `subjectToPcb: true`, and to Form EA disclosures.
  /// The calc engine accumulates these into `totalBenefitsInKind`
  /// rather than `totalAllowances`.
  nonCash?: boolean
}

export const PAYROLL_ADJUSTMENT_CATEGORY_META: Record<
  PayrollAdjustmentCategory,
  PayrollAdjustmentCategoryMeta
> = {
  allowance_standard: {
    code: "allowance_standard",
    label: "Standard Allowance",
    group: "Allowances / Recurring Monthly",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: true,
  },
  allowance_travel_official: {
    // Travelling / petrol / toll for travel in EXERCISING the
    // employment (not commuting). PCB-exempt up to RM 6,000/year per
    // LHDN Public Ruling 5/2019 §7.2.1. If the employee keeps proper
    // records, they can claim the actual amount as a deduction at
    // year-end (out of scope for monthly PCB).
    code: "allowance_travel_official",
    label: "Travel/Petrol/Toll (Official Duty)",
    group: "Allowances / Recurring Monthly",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: true,
    subjectToHrdf: false,
    taxExemptLimit: 6000,
  },
  allowance_travel_private: {
    code: "allowance_travel_private",
    label: "Travel/Petrol Allowance (Private Use/Commuting)",
    group: "Allowances / Recurring Monthly",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: false,
  },
  allowance_parking: {
    // Parking rate or parking allowance — fully PCB-exempt per LHDN
    // Public Ruling 5/2019 §7.2.2. Includes parking rate paid by the
    // employer directly to the parking operator. Admin is expected to
    // keep the amount "reasonable and not excessive" (LHDN's wording).
    code: "allowance_parking",
    label: "Parking Allowance",
    group: "Allowances / Recurring Monthly",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: false,
    subjectToHrdf: true,
  },
  allowance_meal: {
    // Meal allowance given on a regular basis (daily/monthly) at the
    // same rate to all employees — fully PCB-exempt per LHDN Public
    // Ruling 5/2019 §7.2.3. "Reasonable and not excessive" amount.
    // Outstation / overtime / per-diem meal allowances are also
    // exempt when given per internal-circular rates.
    code: "allowance_meal",
    label: "Meal Allowance",
    group: "Allowances / Recurring Monthly",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: false,
    subjectToHrdf: true,
  },
  allowance_childcare: {
    // Child-care allowance paid to the employee or directly to the
    // child-care centre. PCB-exempt up to RM 2,400/year per LHDN
    // Public Ruling 5/2019 §7.2.4. "Child" = under 12 years old; the
    // admin is responsible for verifying eligibility. Excess above
    // RM 2,400 YTD becomes PCB-subject; EPF/SOCSO/EIS/HRDF treatment
    // is unaffected (the allowance is wages for those purposes).
    code: "allowance_childcare",
    label: "Childcare Allowance",
    group: "Allowances / Recurring Monthly",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: true,
    taxExemptLimit: 2400,
  },
  allowance_phone_bill: {
    // Monthly bills for fixed-line / mobile / pager / PDA / broadband
    // registered under the employee's name — fully PCB-exempt per
    // LHDN Public Ruling 5/2019 §7.4.2 + §7.4.3. Cost of registration
    // and installation included. Exemption is LIMITED TO ONE UNIT per
    // asset category per year — admin enforces this manually (we
    // don't track per-line-item unit counts).
    code: "allowance_phone_bill",
    label: "Phone/Internet Bill Payment",
    group: "Allowances / Recurring Monthly",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: false,
    subjectToHrdf: true,
  },
  allowance_phone_fixed: {
    // FIXED phone allowance (cash paid to the employee, not a bill
    // reimbursed by the employer). Fully PCB-taxable per LHDN Public
    // Ruling 5/2019 §7.4.4 — "the full amount of that telephone
    // allowance is taxable as part of his gross income from
    // employment".
    code: "allowance_phone_fixed",
    label: "Phone Allowance (Fixed)",
    group: "Allowances / Recurring Monthly",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: true,
  },
  wages_bonus_annual: {
    code: "wages_bonus_annual",
    label: "Annual Bonus",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: true,
    subjectToHrdf: false,
    isAdditionalRemuneration: true,
  },
  wages_bonus_non_annual: {
    code: "wages_bonus_non_annual",
    label: "Non-Annual Bonus",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: false,
    isAdditionalRemuneration: true,
  },
  wages_commission: {
    code: "wages_commission",
    label: "Commission",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: false,
    isAdditionalRemuneration: true,
  },
  wages_incentive: {
    code: "wages_incentive",
    label: "Incentive",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: false,
    isAdditionalRemuneration: true,
  },
  wages_arrears: {
    code: "wages_arrears",
    label: "Arrears of Wages",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: true,
    isAdditionalRemuneration: true,
  },
  wages_overtime: {
    code: "wages_overtime",
    label: "Overtime",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: false,
  },
  wages_service_charge: {
    code: "wages_service_charge",
    label: "Service Charge",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: false,
  },
  wages_leave_pay: {
    code: "wages_leave_pay",
    label: "Unutilized Leave Pay",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: true,
    isAdditionalRemuneration: true,
  },
  wages_gratuity: {
    code: "wages_gratuity",
    label: "Gratuity",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: true,
    subjectToHrdf: false,
    isAdditionalRemuneration: true,
  },
  wages_compensation_loss_employment: {
    // Compensation for Loss of Employment (CLOE). LHDN Schedule 6
    // Paragraph 15(1) gives a tax-exempt amount of RM 10,000 per
    // completed year of service. Because the cap is per year of
    // service (not per calendar year), it can't be modelled with a
    // simple `taxExemptLimit`; the admin should enter the taxable
    // portion only, after subtracting the exempt amount externally.
    // Not subject to EPF/SOCSO/EIS (termination payment, not wages).
    code: "wages_compensation_loss_employment",
    label: "Compensation for Loss of Employment",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: true,
    subjectToHrdf: false,
    isAdditionalRemuneration: true,
  },
  wages_ex_gratia: {
    // Ex-gratia payment — voluntary payment by the employer beyond
    // contractual entitlement (e.g. severance not tied to retirement
    // or termination cause). Distinct from gratuity (retirement) and
    // CLOE (loss-of-employment) because it has no statutory tax
    // exemption — fully taxable.
    code: "wages_ex_gratia",
    label: "Ex-gratia",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: true,
    subjectToHrdf: false,
    isAdditionalRemuneration: true,
  },
  wages_tax_borne_by_employer: {
    // Tax borne by employer perquisite. When the employer agrees to
    // pay the employee's PCB, the payment is itself a taxable
    // perquisite to the employee (LHDN MTD Spec page 12).
    //
    // Note: AltomateHR does NOT yet implement the iterative gross-up
    // calculation. Until that ships, this category exists only as a
    // documentation line item — the admin enters the perquisite
    // amount manually (computed externally), and it routes through
    // the AR path. See `PayrollProfile.pcbBorneByEmployer` flag for
    // the broader gap.
    code: "wages_tax_borne_by_employer",
    label: "Tax Borne by Employer (perquisite)",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: true,
    subjectToHrdf: false,
    isAdditionalRemuneration: true,
  },
  wages_director_fee: {
    code: "wages_director_fee",
    label: "Director Fee",
    group: "Remuneration",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: true,
    subjectToHrdf: false,
    isAdditionalRemuneration: true,
  },
  wages_expense_claim: {
    code: "wages_expense_claim",
    label: "Expense Claim",
    group: "Remuneration",
    kind: "REIMBURSEMENT",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: false,
    subjectToHrdf: false,
  },
  bik_car: {
    code: "bik_car",
    label: "Car/Petrol BIK",
    group: "Benefits-in-kind / Perquisites",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: true,
    subjectToHrdf: false,
    nonCash: true,
  },
  bik_medical: {
    code: "bik_medical",
    label: "Medical/Dental Benefit",
    group: "Benefits-in-kind / Perquisites",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: false,
    subjectToHrdf: false,
    nonCash: true,
  },
  bik_award: {
    code: "bik_award",
    label: "Awards/Rewards",
    group: "Benefits-in-kind / Perquisites",
    kind: "ALLOWANCE",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: false,
    taxExemptLimit: 2000,
    isAdditionalRemuneration: true,
  },
  bik_living_accommodation: {
    code: "bik_living_accommodation",
    label: "Living Accommodation",
    group: "Benefits-in-kind / Perquisites",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: true,
    subjectToHrdf: false,
    nonCash: true,
  },
  bik_share_scheme: {
    code: "bik_share_scheme",
    label: "Share Scheme",
    group: "Benefits-in-kind / Perquisites",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: true,
    subjectToHrdf: false,
    isAdditionalRemuneration: true,
    nonCash: true,
  },
  bik_subsidised_loan: {
    // Subsidised interest on housing/education/car loan. Per LHDN
    // MTD Spec page 22 (item viii), fully exempt from PCB when the
    // aggregate loan principal ≤ RM 300,000. Above that, only a
    // formula-based portion is exempt — admin must enter just the
    // taxable portion when applicable.
    //
    // For the common case (small loans) we keep it fully PCB-exempt
    // by default; the admin overrides the amount if the formula
    // partial-exemption kicks in.
    code: "bik_subsidised_loan",
    label: "Subsidised Loan Interest",
    group: "Benefits-in-kind / Perquisites",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: false,
    subjectToHrdf: false,
    nonCash: true,
  },
  bik_phone_pda_gift: {
    // One-time gift of fixed-line / mobile phone / pager / PDA, in
    // the name of the employee or employer (LHDN MTD Spec page 21,
    // item iii). Limited to 1 unit per category per year — admin
    // enforces the per-category limit manually since we don't track
    // unit counts. Fully exempt from PCB.
    code: "bik_phone_pda_gift",
    label: "Gift of Phone / PDA (1 unit/category/year)",
    group: "Benefits-in-kind / Perquisites",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: false,
    subjectToHrdf: false,
    nonCash: true,
  },
  bik_other_exempt: {
    code: "bik_other_exempt",
    label: "Other Tax Exempt Benefit",
    group: "Benefits-in-kind / Perquisites",
    kind: "ALLOWANCE",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: false,
    subjectToHrdf: false,
    nonCash: true,
  },
  deduct_unpaid_leave: {
    code: "deduct_unpaid_leave",
    label: "Unpaid Leave deduction",
    group: "Deductions",
    kind: "DEDUCTION",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    // Unpaid leave reduces the HRDF wage base too — those days
    // weren't worked, so the basic+allowance pay attributable to
    // them shouldn't be in the levy base.
    subjectToHrdf: true,
    reducesBase: true,
    // Unpaid leave is lost earnings: dock it from GROSS (not just net),
    // while the base-salary line still shows the full salary.
    reducesGross: true,
    // The deduction is already the full daily rate × unpaid days, so it
    // must not be re-prorated by the join/leave factor.
    skipProration: true,
  },
  deduct_salary_adjustment: {
    code: "deduct_salary_adjustment",
    label: "Salary Adjustment",
    group: "Deductions",
    kind: "DEDUCTION",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: false,
    reducesBase: true,
  },
  deduct_advance: {
    code: "deduct_advance",
    label: "Advance Deduction",
    group: "Deductions",
    kind: "DEDUCTION",
    subjectToEpf: true,
    subjectToSocso: true,
    subjectToEis: true,
    subjectToPcb: true,
    subjectToHrdf: false,
    reducesBase: true,
  },
  deduct_cp38: {
    code: "deduct_cp38",
    label: "CP38 Deduction",
    group: "Deductions",
    kind: "DEDUCTION",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: false,
    subjectToHrdf: false,
    referenceOnly: true,
  },
  deduct_zakat: {
    code: "deduct_zakat",
    label: "Zakat — via salary deduction (PZB)",
    group: "Deductions",
    kind: "DEDUCTION",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: false,
    subjectToHrdf: false,
    offsetsPcb: true,
  },
  deduct_zakat_tp1: {
    code: "deduct_zakat_tp1",
    label: "Zakat — self-paid (TP1)",
    group: "Deductions",
    kind: "DEDUCTION",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: false,
    subjectToHrdf: false,
    // Employee paid the zakat centre directly and declared it via Borang
    // TP1 §D1(a). It offsets this month's PCB but is NOT taken from
    // take-home pay (cashNeutral) — the money already left their pocket.
    offsetsPcb: true,
    cashNeutral: true,
  },
  deduct_tp1: {
    code: "deduct_tp1",
    label: "TP1/TP3 Deduction",
    group: "Deductions",
    kind: "DEDUCTION",
    subjectToEpf: false,
    subjectToSocso: false,
    subjectToEis: false,
    subjectToPcb: false,
    subjectToHrdf: false,
    referenceOnly: true,
  },
}

export const payrollAdjustmentCategoryGroups = [
  "Allowances / Recurring Monthly",
  "Remuneration",
  "Benefits-in-kind / Perquisites",
  "Deductions",
] as const

/**
 * Recurring per-month adjustment applied to every payroll run for an
 * employee. Compared to a PayslipLineItem (which is per-payslip), this
 * is the template version that auto-creates line items on each run.
 * Legacy saved rows without `category` are treated as Standard
 * Allowance by repositories and actions.
 */
export type FixedAllowance = {
  category: PayrollAdjustmentCategory
  name: string
  amount: number
  /// LHDN Additional Remuneration override. See `ManualLineItem.treatAsRecurring`
  /// in `runs.ts` for the full explanation. Default `false` (= AR
  /// formula on bonus / commission / arrears / gratuity / director-fee
  /// categories). Set `true` when the same category is paid every
  /// month at a similar amount — e.g., a sales rep on monthly
  /// commission, or a director on a monthly directors' fee — so PCB
  /// stays smooth instead of spiking each month.
  treatAsRecurring?: boolean
}

// ─── Leave entitlement JSON shape (v2 placeholder) ───────────────────────

export type LeaveEntitlement = {
  type: string // e.g. "ANNUAL" | "SICK" — to be enum'd when leave module ships
  days: number
}

// ─── Payroll documents (contracts, offer letters, etc.) ─────────────────

/**
 * One uploaded HR document attached to an employee's payroll profile.
 * Files themselves live on local disk under
 * `public/uploads/payroll-documents/{userId}/`; this metadata gets
 * persisted as a JSON array on `PayrollProfile.payrollDocuments`.
 */
export type PayrollDocument = {
  /// Stable id (cuid-like) — used for delete + react keys.
  id: string
  /// Original filename as uploaded by the admin.
  name: string
  /// MIME type at upload time.
  mimeType: string
  /// Size in bytes at upload time.
  sizeBytes: number
  /// Public URL the UI fetches to view/download. For local files this
  /// is `/uploads/payroll-documents/{userId}/{storedFilename}`.
  url: string
  /// ISO timestamp (uploadedAt).
  uploadedAt: string
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

  // Previous employment — TP3 carryover for mid-year joiners.
  // Each field is consumed by the run service when
  // `prevEmploymentYear` matches the current run's calendar year.
  prevEmploymentYear: number | null
  prevRemuneration: number | null      // Y
  prevEpf: number | null               // K
  prevPcb: number | null               // X
  prevZakat: number | null             // Z
  prevAllowableDeductions: number | null // ΣLP

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
  /// Review/checkpoint date for temporary employees (probation end,
  /// fixed-term review). Only meaningful when the assigned policy is
  /// temporary. ISO yyyy-mm-dd.
  temporaryReviewDate: string | null
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

  // Uploaded HR documents (contracts, offer letters, etc.)
  payrollDocuments: PayrollDocument[]

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
  /// Compensation basis — drives whether the run shows HRS as a % or as
  /// absolute hours. Defaults to MONTHLY when no profile exists yet.
  salaryType: SalaryType
  /// True if a PayrollProfile row exists for this employee at all.
  hasProfile: boolean
  /// True only when every required statutory + compensation field is filled
  /// in. Drives the "incomplete" visual indicator on the list page.
  isComplete: boolean
  /// True when the profile is archived. Archived rows are still shown on
  /// the list (greyed out) so admin can un-archive.
  isArchived: boolean
  /// True when the employee's salary is set to 0 — an intentional opt-out
  /// from payroll runs. Drives a grey "Excluded — no salary" chip on
  /// the list page instead of the red "Incomplete" warning.
  isExcluded: boolean
  /// First day on payroll. Used by the run detail page to exclude
  /// employees whose joinDate is AFTER the current run's period (haven't
  /// started yet — shouldn't appear in "Will be included"). Null when
  /// the profile doesn't have a join date yet.
  joinDate: string | null
  /// Last day on payroll. Used to exclude employees whose leaveDate is
  /// BEFORE the current run's period (already left). Null = still active.
  leaveDate: string | null
}

// ─── Completion check ─────────────────────────────────────────────────────

/**
 * Pure helper: tiny "is this string-ish value present?" check used by
 * the per-tab completion helpers below. `null` / `undefined` / `""` /
 * "   " are all blank; anything else (incl. numbers, booleans) counts.
 */
function hasValue(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value != null
}

/**
 * Personal-tab completion. These are the identity / contact / family
 * fields LHDN E-filing + payslip generation need:
 *   - gender, dateOfBirth (EIS age gating)
 *   - nationality, idType, idNumber (PCB TXT + SOCSO+EIS file)
 *   - maritalStatus (drives spouse + child relief calc)
 *   - addressLine1, city, postcode, state (payslip + LHDN filings)
 *
 * When marital status is MARRIED, spouseWorking must also be set
 * (drives the PCB joint-relief branch).
 */
export function isPersonalTabComplete(p: PayrollProfileData): boolean {
  if (!hasValue(p.gender)) return false
  if (!hasValue(p.dateOfBirth)) return false
  if (!hasValue(p.nationality)) return false
  if (!hasValue(p.idType)) return false
  if (!hasValue(p.idNumber)) return false
  if (!hasValue(p.maritalStatus)) return false
  if (!hasValue(p.addressLine1)) return false
  if (!hasValue(p.city)) return false
  if (!hasValue(p.postcode)) return false
  if (!hasValue(p.state)) return false
  // Spouse-working is required when married (drives PCB spouse reliefs:
  // S = RM 4,000 when spouse has no income, plus SU = RM 6,000 if also
  // disabled). Without this, PCB defaults to the safer "no relief"
  // path which can over-withhold tax.
  if (p.maritalStatus === "MARRIED" && p.spouseWorking == null) return false
  return true
}

/**
 * Employment-tab completion. Salary structure + join date — the bare
 * minimum the payroll calc engine needs to compute a run.
 *   - salaryType matches a non-negative value (0 is allowed; means
 *     "excluded from payroll" — handled by `isExcludedFromPayroll`)
 *   - joinDate (proration on first / last month)
 */
export function isEmploymentTabComplete(p: PayrollProfileData): boolean {
  if (p.salaryType === "MONTHLY" && (p.monthlySalary == null || p.monthlySalary < 0)) {
    return false
  }
  if (p.salaryType === "HOURLY" && (p.hourlyRate == null || p.hourlyRate < 0)) {
    return false
  }
  if (!hasValue(p.joinDate)) return false
  return true
}

/**
 * Statutory-tab completion. Numbers required for LHDN / EPF / SOCSO
 * file generation:
 *   - if EPF contribution enabled → EPF number
 *   - if a SOCSO scheme is set → SOCSO number
 *   - incomeTaxNumber (always; required for PCB TXT + CP39)
 */
export function isStatutoryTabComplete(p: PayrollProfileData): boolean {
  if (p.contributeToEpf && !hasValue(p.epfNumber)) return false
  if (hasValue(p.socsoScheme) && !hasValue(p.socsoNumber)) return false
  if (!hasValue(p.incomeTaxNumber)) return false
  return true
}

/**
 * Pure helper: decide whether a payroll profile has all the fields
 * needed for the "Ready for payroll" badge + the `listReadyForPayroll`
 * gate. Composed of the three per-tab completion checks so the UI tab
 * pills (Personal / Employment / Statutory) and the badge can never
 * disagree — single source of truth.
 *
 * Bank info is NOT required to run a payroll calc — it's only needed
 * to actually disburse. So we don't gate completeness on it.
 */
export function isPayrollProfileComplete(p: PayrollProfileData): boolean {
  return (
    isPersonalTabComplete(p) &&
    isEmploymentTabComplete(p) &&
    isStatutoryTabComplete(p)
  )
}

/**
 * Pure helper: a profile is "excluded from payroll" when its salary
 * value for the chosen type is exactly 0. This is an intentional opt-out
 * (e.g. directors who don't draw a salary, employees on unpaid leave,
 * contractors paid outside payroll) — separate from "incomplete".
 *
 * Used by `listReadyForPayroll` to skip these employees from run drafts,
 * and by the admin UI to render an "Excluded" chip in place of the red
 * "Incomplete" warning.
 *
 * Assumes the profile is already complete (`isPayrollProfileComplete`
 * returned true), so monthlySalary / hourlyRate is non-null for the
 * relevant type.
 */
export function isExcludedFromPayroll(p: PayrollProfileData): boolean {
  // Zero base pay no longer means "skip payroll" on its own — an
  // allowance-only employee (salary 0 but with a recurring earning
  // allowance) still gets paid, so they belong on the run. Only treat
  // them as excluded when there's genuinely nothing to pay: zero base
  // pay AND no positive earning allowance on the profile.
  const hasEarningAllowance = (p.fixedAllowances ?? []).some((a) => {
    const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[a.category]
    return meta?.kind === "ALLOWANCE" && a.amount > 0
  })
  if (hasEarningAllowance) return false
  if (p.salaryType === "MONTHLY") return p.monthlySalary === 0
  if (p.salaryType === "HOURLY") return p.hourlyRate === 0
  return false
}
