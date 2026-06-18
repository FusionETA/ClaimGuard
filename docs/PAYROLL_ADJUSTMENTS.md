# Payroll Adjustments — Statutory Treatment

Source of truth: `PAYROLL_ADJUSTMENT_CATEGORY_META` in
[modules/payroll/domain/models.ts](../modules/payroll/domain/models.ts).

Legend:

- ✅ subject to / ❌ not subject to / — N/A
- **AR** = Additional Remuneration (one-off; PCB calculated as tax delta, not projected forward)
- **Exempt** = annual PCB-exempt limit (excess YTD becomes PCB-subject)
- **BIK** = non-cash benefit (counted in PCB base + EA, not gross/net cash)

---

## 1. Allowances / Recurring Monthly

| Item | EPF | SOCSO | EIS | PCB | HRDF | Notes |
|---|:-:|:-:|:-:|:-:|:-:|---|
| Standard Allowance | ✅ | ✅ | ✅ | ✅ | ✅ | |
| Travel/Petrol/Toll (Official Duty) | ❌ | ❌ | ❌ | ✅ | ❌ | Exempt RM 6,000/yr (PR 5/2019 §7.2.1) |
| Travel/Petrol Allowance (Private / Commuting) | ✅ | ✅ | ✅ | ✅ | ✅ | |
| Parking Allowance | ✅ | ✅ | ✅ | ❌ | ✅ | PCB-exempt (PR 5/2019 §7.2.2) |
| Meal Allowance | ✅ | ✅ | ✅ | ❌ | ✅ | PCB-exempt (PR 5/2019 §7.2.3) |
| Childcare Allowance | ✅ | ✅ | ✅ | ✅ | ✅ | Exempt RM 2,400/yr (PR 5/2019 §7.2.4) |
| Phone/Internet Bill Payment | ✅ | ✅ | ✅ | ❌ | ✅ | PCB-exempt, 1 unit/category/yr (PR 5/2019 §7.4.2–3) |
| Phone Allowance (Fixed cash) | ✅ | ✅ | ✅ | ✅ | ✅ | Fully taxable (PR 5/2019 §7.4.4) |

---

## 2. Remuneration

| Item | EPF | SOCSO | EIS | PCB | HRDF | Notes |
|---|:-:|:-:|:-:|:-:|:-:|---|
| Annual Bonus | ✅ | ❌ | ❌ | ✅ | ❌ | AR |
| Non-Annual Bonus | ✅ | ✅ | ✅ | ✅ | ❌ | AR |
| Commission | ✅ | ✅ | ✅ | ✅ | ❌ | AR |
| Incentive | ✅ | ✅ | ✅ | ✅ | ❌ | AR |
| Arrears of Wages | ✅ | ✅ | ✅ | ✅ | ✅ | AR |
| Overtime | ❌ | ✅ | ✅ | ✅ | ❌ | |
| Service Charge | ❌ | ✅ | ✅ | ✅ | ❌ | |
| Unutilized Leave Pay | ✅ | ✅ | ✅ | ✅ | ✅ | AR |
| Gratuity | ❌ | ❌ | ❌ | ✅ | ❌ | AR (termination payment) |
| Compensation for Loss of Employment (CLOE) | ❌ | ❌ | ❌ | ✅ | ❌ | AR; Sch 6 ¶15(1) exempt RM 10,000 per completed year — admin enters taxable portion |
| Ex-gratia | ❌ | ❌ | ❌ | ✅ | ❌ | AR; fully taxable (no statutory exemption) |
| Tax Borne by Employer (perquisite) | ❌ | ❌ | ❌ | ✅ | ❌ | AR; admin enters grossed-up amount (iterative not yet automated) |
| Director Fee | ❌ | ❌ | ❌ | ✅ | ❌ | AR |
| Expense Claim | ❌ | ❌ | ❌ | ❌ | ❌ | Reimbursement — not income |

---

## 3. Benefits-in-Kind / Perquisites

All non-cash — counted in PCB base + Form EA where subject, not in cash gross/net.

| Item | EPF | SOCSO | EIS | PCB | HRDF | Notes |
|---|:-:|:-:|:-:|:-:|:-:|---|
| Car/Petrol BIK | ❌ | ❌ | ❌ | ✅ | ❌ | BIK |
| Medical/Dental Benefit | ❌ | ❌ | ❌ | ❌ | ❌ | BIK; exempt |
| Awards/Rewards | ✅ | ✅ | ✅ | ✅ | ❌ | AR; Exempt RM 2,000/yr |
| Living Accommodation | ❌ | ❌ | ❌ | ✅ | ❌ | BIK |
| Share Scheme | ❌ | ❌ | ❌ | ✅ | ❌ | AR; BIK |
| Subsidised Loan Interest | ❌ | ❌ | ❌ | ❌ | ❌ | BIK; PCB-exempt if aggregate principal ≤ RM 300,000 (MTD Spec p.22 item viii) |
| Gift of Phone / PDA (1 unit/category/yr) | ❌ | ❌ | ❌ | ❌ | ❌ | BIK; one-time (MTD Spec p.21 item iii) |
| Other Tax Exempt Benefit | ❌ | ❌ | ❌ | ❌ | ❌ | BIK |

---

## 4. Deductions

| Item | EPF | SOCSO | EIS | PCB | HRDF | Notes |
|---|:-:|:-:|:-:|:-:|:-:|---|
| Unpaid Leave deduction | ✅ | ✅ | ✅ | ✅ | ✅ | Reduces base + gross; not re-prorated for join/leave |
| Salary Adjustment | ✅ | ✅ | ✅ | ✅ | ❌ | Reduces base |
| Advance Deduction | ✅ | ✅ | ✅ | ✅ | ❌ | Reduces base |
| CP38 Deduction | ❌ | ❌ | ❌ | ❌ | ❌ | Reference-only (separate LHDN instalment) |
| Zakat — via salary deduction (PZB) | ❌ | ❌ | ❌ | ❌ | ❌ | Offsets PCB (capped at month's PCB) |
| Zakat — self-paid (TP1) | ❌ | ❌ | ❌ | ❌ | ❌ | Offsets PCB; cash-neutral (already paid by employee) |
| TP1/TP3 Deduction | ❌ | ❌ | ❌ | ❌ | ❌ | Reference-only (employee-declared reliefs) |

---

## Quick reference flags

- **Reduces gross pay**: Unpaid Leave (others reduce net only).
- **Reduces base**: Unpaid Leave, Salary Adjustment, Advance — subtract from base salary before stat. calcs.
- **Skips proration**: Unpaid Leave (already at full daily rate × days).
- **Offsets PCB**: Zakat (PZB) and Zakat-TP1.
- **Cash-neutral**: Zakat-TP1 only — affects PCB but not take-home.
- **Reference-only**: CP38, TP1/TP3 — shown for context, not in any calc.
- **Additional Remuneration**: all bonuses/commissions/incentives/arrears/leave-pay/gratuity/CLOE/ex-gratia/tax-borne/director-fee/awards/share-scheme. Calc engine uses
  `PCB_AR = tax(chargeable_with_AR) − tax(chargeable_normal)` for these — no monthly projection.

---

## HRDF wage base (PSMB Act 2001 §2)

HRDF levy "wages" = basic salary + fixed allowances of a like nature + leave pay + arrears.

Excluded: travel allowance, special-expense reimbursements, gratuity, bonus, commission, apprentice allowances.

Per-row `subjectToHrdf` flags above are the source of truth; defaults to `true` at the calc site when omitted.
