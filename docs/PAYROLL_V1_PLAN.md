# Workpulse Payroll v1 — Implementation Plan

> Status: **planning** — not implemented yet. Reviewed before coding starts.
>
> Country: Malaysia only. Currency: MYR only.
>
> Goal: a working payroll module that can produce a per-employee payslip
> for a given month with basic pay, OT, allowances, deductions, and
> statutory contributions (EPF / SOCSO / EIS). PCB is **deferred to v2**.

---

## 1. Scope decisions (locked from Q&A)

### In v1

| Area | Decision |
|---|---|
| Basic pay | Monthly + hourly |
| OT | Normal / Rest / Public Holiday (multipliers configurable) |
| Allowances | Simple line items (name + amount). All subject to EPF/SOCSO/EIS. **No category matrix v1.** |
| Deductions | Simple line items (name + amount). Subtracted from gross. |
| Proration | New joiners / leavers prorated. Both `calendar` and `26_days` methods supported. |
| EPF | Per-employee mandatory rate (default 11% employee / 13% employer) + optional voluntary. Stepped wage rounding included. |
| SOCSO | First-category + second-category, fixed rates, RM6,000 ceiling |
| EIS | Fixed rate, RM6,000 ceiling |
| Foreign worker EPF | Branch included from day 1 (Malaysian vs non-Malaysian uses different rule) |
| Claims → Payroll | New button on `/admin/claims` for `SYNCED` claims; attaches as exempt reimbursement line item. Runs **in parallel** to Xero sync. |
| Payroll run workflow | Draft → Submit. Revertible until next month's run is created. |
| Payslip output | On-screen view inside Workpulse. **No PDF v1.** |
| Admin scope | Same admins who manage claims also manage payroll. |
| Data | Fresh start. Separate `PayrollProfile` table FK'd to existing `EmployeeProfile`. |
| Architecture | New `modules/payroll/` module, layered (domain / application / infrastructure) like the rest of the codebase. |

### Deferred to v1.1

- PDF payslip generation
- Allowance categorization matrix (per-allowance EPF/SOCSO/EIS/PCB applicability flags)
- Form E filing flow (capture the data fields now, build the filing UI later)
- Employee payslip emails

### Deferred to v2

- **PCB calculation** (residential + non-resident, additional remuneration, YTD tracking, child/spouse/disabled reliefs, zakat offset, TP1/TP3, CP38)
- Leave module integration (unpaid leave deductions)
- Attendance integration (hours from clock-in/out drives hourly pay)
- HRDF calculation
- TP3 import / previous employment income carry-over

### Deferred to v3+

- Multi-country (Singapore / Indonesia / etc.)
- Annual rate-update UI (currently hardcoded for 2026)
- Multi-admin approval workflow on payroll runs
- e-Data Praisi / e-CP8D direct submission

---

## 2. Architecture

```
modules/payroll/
├── domain/
│   ├── models.ts                  ← types: PayrollProfile, PayrollSettings, PayrollRun, Payslip, PayslipLineItem
│   └── calculations.ts            ← pure functions: calcEPF, calcSOCSO, calcEIS, prorate, etc.
├── application/
│   └── services/
│       ├── payroll-profile.service.ts
│       ├── payroll-settings.service.ts
│       ├── payroll-run.service.ts
│       └── payslip.service.ts
└── infrastructure/
    ├── payroll-profile.repository.ts
    ├── payroll-settings.repository.ts
    ├── payroll-run.repository.ts
    └── payslip.repository.ts
```

Rules from `CLAUDE.md` apply: pages call services, services call repos, repos own all Prisma. Calculations live in `domain/calculations.ts` and are pure (no DB, no IO) so they can be unit-tested against the user's test set.

---

## 3. Schema design (new Prisma models)

**Mapped to Altomate's existing structure** (user-provided reference):

| Altomate table | Workpulse model | Notes |
|---|---|---|
| `p_employee` | `PayrollProfile` | One row per employee, FK'd to `EmployeeProfile`. Includes status/archive flag, fixed allowance JSON, leave entitlement JSON (v2 placeholder). |
| `p_settings` | `PayrollSettings` | Per-org payroll **rules**: OT multipliers, working-days rule, EPF defaults, employer ID, MyCo ID. |
| `p_company_settings` | `PayrollCompanyInfo` | Per-org **employer profile**: Form E particulars, correspondence, tax agent, declarant. Separated from `PayrollSettings` because it's a different concern with a different update cadence. |
| `p_payroll` | `PayrollRun` | One per (org, year, month). |
| `p_payslips` | `Payslip` + `PayslipLineItem` | Altomate stores additions as JSON; Workpulse normalizes them into a separate `PayslipLineItem` table so claims can FK to their corresponding line item directly (no JSON parsing for "which payslips contain this claim?"). |
| `p_payroll_activation`, `p_plan_selection`, `p_invoice` | **Out of scope** | Altomate-specific monetization layer. Workpulse handles billing separately and doesn't need per-feature activation. |


### `PayrollProfile`

Per-employee payroll-specific data. FK'd to `EmployeeProfile` so it can be lazy-created when payroll onboards an existing employee.

```prisma
model PayrollProfile {
  id                String   @id @default(cuid())
  employeeProfileId String   @unique
  employeeProfile   EmployeeProfile @relation(...)

  // Personal / statutory
  phone             String?
  gender            Gender?         // enum: MALE | FEMALE
  dateOfBirth       DateTime?
  nationality       String?         // "Malaysian" | "Singaporean" | etc.
  idType            IdType?         // enum: NRIC | PASSPORT | ARMY_NO | POLICE_NO
  idNumber          String?
  maritalStatus     MaritalStatus?  // enum: SINGLE | MARRIED | DIVORCED | WIDOWED
  isResident        Boolean  @default(true)
  isOku             Boolean  @default(false)   // OKU = disabled

  // Spouse / children (for future PCB reliefs; captured now)
  spouseWorking     Boolean? @default(null)
  spouseDisabled    Boolean? @default(null)
  childRelief       Json?    // { under18: { full: int, half: int }, higherEd: {...}, disabledChild: {...}, disabledHigherEd: {...} }

  // Previous employment (for future TP3 / PCB carryover)
  prevEmploymentYear Int?
  prevRemuneration   Decimal?  @db.Decimal(12,2)
  prevEpf            Decimal?  @db.Decimal(12,2)

  // EPF
  epfNumber          String?
  contributeToEpf    Boolean  @default(true)
  epfEmployeeRate    Decimal  @db.Decimal(5,2)  // default 11.00
  epfEmployeeVoluntary Decimal @db.Decimal(5,2) @default(0)
  epfEmployerVoluntary Decimal @db.Decimal(5,2) @default(0)
  // employer mandatory rate is computed from wage (12% > RM5k, 13% <= RM5k)

  // SOCSO
  socsoNumber        String?
  socsoScheme        SocsoScheme?  // enum: EMPLOYMENT_INJURY_INVALIDITY | EMPLOYMENT_INJURY_ONLY

  // EIS
  contributeToEis    Boolean  @default(true)

  // Income tax / PCB (captured now, calc deferred)
  incomeTaxNumber    String?

  // Compensation
  salaryType         SalaryType    // enum: MONTHLY | HOURLY
  monthlySalary      Decimal? @db.Decimal(12,2)  // when MONTHLY
  hourlyRate         Decimal? @db.Decimal(12,2)  // when HOURLY

  // Fixed allowances (recurring per-month)
  fixedAllowances    Json?    // [{ name, amount }] — applied to every payroll run

  // Bank for payout
  bankName           String?
  bankAccountNumber  String?  // consider encryption later

  // Employment dates (for proration)
  joinDate           DateTime?
  leaveDate          DateTime?

  // Archive / status — matches Altomate's `p_employee` active/archived flag.
  // Archived profiles are excluded from new payroll runs but retain
  // historical payslips. Don't hard-delete — payslips depend on them.
  isArchived         Boolean  @default(false)
  archivedAt         DateTime?

  // Leave entitlement (v2 placeholder — leave module deferred).
  // Stored as JSON for forward-compat. Shape TBD when leave module ships:
  //   [{ type: "ANNUAL", days: 14 }, { type: "SICK", days: 30 }, ...]
  leaveEntitlement   Json?

  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

### `PayrollSettings` (per-org — rates & rules)

Matches Altomate's `p_settings`. Frequently edited by admin (OT rates, EPF defaults, etc.).

```prisma
model PayrollSettings {
  id                  String   @id @default(cuid())
  organizationId      String   @unique
  organization        Organization @relation(...)

  // OT multipliers
  otRateNormal        Decimal  @db.Decimal(5,2) @default(1.50)
  otRateRest          Decimal  @db.Decimal(5,2) @default(2.00)
  otRatePublicHoliday Decimal  @db.Decimal(5,2) @default(3.00)

  // Working-days rule for proration + hourly conversion
  workingDaysRule     WorkingDaysRule @default(TWENTY_SIX)  // enum: CALENDAR | TWENTY_SIX

  // EPF defaults (overridable per employee in PayrollProfile)
  defaultEpfEmployeeRate Decimal @db.Decimal(5,2) @default(11.00)
  defaultEpfEmployerRate Decimal @db.Decimal(5,2) @default(13.00)

  // HRDF — captured now, calc deferred to v2
  hrdfEnabled         Boolean  @default(false)
  hrdfRate            Decimal? @db.Decimal(5,2)  // e.g. 1.00 = 1%

  // Employer identifiers (used for both payroll filing and Form E)
  employerIdNumber    String?  // E Number
  myCoOrSsmNumber     String?

  // Carry-forward rules (v2 placeholders — leave deferred)
  leaveCarryForwardAllowed   Boolean  @default(false)
  leaveCarryForwardLimitDays Int?
  leaveCarryForwardExpiryMonths Int?

  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
}
```

### `PayrollCompanyInfo` (per-org — employer profile / Form E)

Matches Altomate's `p_company_settings`. Updated rarely (annual at most). Separated from `PayrollSettings` because it's a different concern — this is the "filing identity" of the company, not the operational rules.

```prisma
model PayrollCompanyInfo {
  id                 String   @id @default(cuid())
  organizationId     String   @unique
  organization       Organization @relation(...)

  // Employer basic particulars (Form E)
  employerName       String?
  employerTin        String?
  registrationNo     String?
  referenceType      String?     // "03 - C" etc.
  referenceNo        String?
  employerCategory   String?     // "5 - Private Sector (Other than Company)" etc.
  employerStatus     String?     // "1 - In Operation"
  cp8dFurnishType    String?     // "1 - Via e-Data Praisi / e-CP8D"

  // Correspondence
  addressLine1       String?
  addressLine2       String?
  postcode           String?
  city               String?
  state              String?
  country            String?  @default("Malaysia")
  phone              String?
  handphone          String?
  email              String?

  // Tax agent (Form E section)
  taxAgentName       String?
  taxAgentTin        String?
  taxAgentLicenceNo  String?
  taxAgentPhone      String?
  taxAgentEmail      String?

  // Declarant (the person who signs Form E)
  declarantName      String?
  declarantIdType    IdType?
  declarantIdNumber  String?
  declarantPosition  String?

  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

### `PayrollRun` (one per org per month)

```prisma
model PayrollRun {
  id                String   @id @default(cuid())
  organizationId    String
  organization      Organization @relation(...)

  periodYear        Int
  periodMonth       Int           // 1–12
  status            PayrollRunStatus @default(DRAFT)  // enum: DRAFT | SUBMITTED

  // Totals (computed on submit, cached for the list view)
  totalGross        Decimal? @db.Decimal(14,2)
  totalNet          Decimal? @db.Decimal(14,2)
  totalEmployeeEpf  Decimal? @db.Decimal(14,2)
  totalEmployerEpf  Decimal? @db.Decimal(14,2)
  totalEmployeeSocso Decimal? @db.Decimal(14,2)
  totalEmployerSocso Decimal? @db.Decimal(14,2)
  totalEmployeeEis  Decimal? @db.Decimal(14,2)
  totalEmployerEis  Decimal? @db.Decimal(14,2)
  totalPcb          Decimal? @db.Decimal(14,2)  // 0 in v1; populated when PCB ships
  employeeCount     Int?

  submittedAt       DateTime?
  submittedById     String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  payslips          Payslip[]

  @@unique([organizationId, periodYear, periodMonth])
}
```

### `Payslip` (one per employee per run)

```prisma
model Payslip {
  id              String   @id @default(cuid())
  payrollRunId    String
  payrollRun      PayrollRun @relation(...)
  employeeProfileId String
  employeeProfile EmployeeProfile @relation(...)

  // Snapshot of employee data at the moment of payslip generation
  // (so later changes to PayrollProfile don't rewrite history)
  snapshotName       String
  snapshotEmployeeId String
  snapshotPosition   String?
  snapshotSalaryType SalaryType
  snapshotMonthlySalary Decimal? @db.Decimal(12,2)
  snapshotHourlyRate Decimal? @db.Decimal(12,2)
  snapshotNationality String?
  snapshotIsResident Boolean
  snapshotEpfRates   Json     // { employee: 11, employer: 13, voluntaryEmployee: 0, voluntaryEmployer: 0 }

  // Computed values
  basicPay          Decimal  @db.Decimal(12,2)
  proratedPay       Decimal  @db.Decimal(12,2)   // basic after proration
  workedHours       Decimal? @db.Decimal(8,2)    // when HOURLY
  proratedFactor    Decimal  @db.Decimal(5,4) @default(1.0000)
  proratedDays      Int?
  totalWorkingDays  Int?

  // OT breakdown
  otNormalHours     Decimal  @db.Decimal(8,2) @default(0)
  otRestHours       Decimal  @db.Decimal(8,2) @default(0)
  otPublicHours     Decimal  @db.Decimal(8,2) @default(0)
  otPay             Decimal  @db.Decimal(12,2) @default(0)

  // Aggregated totals
  totalAllowances   Decimal  @db.Decimal(12,2) @default(0)
  totalReimbursements Decimal @db.Decimal(12,2) @default(0)  // claims
  totalDeductions   Decimal  @db.Decimal(12,2) @default(0)
  unpaidLeaveDeduction Decimal @db.Decimal(12,2) @default(0)

  // Statutory
  epfEmployee       Decimal  @db.Decimal(12,2) @default(0)
  epfEmployer       Decimal  @db.Decimal(12,2) @default(0)
  socsoEmployee     Decimal  @db.Decimal(12,2) @default(0)
  socsoEmployer     Decimal  @db.Decimal(12,2) @default(0)
  eisEmployee       Decimal  @db.Decimal(12,2) @default(0)
  eisEmployer       Decimal  @db.Decimal(12,2) @default(0)
  pcb               Decimal  @db.Decimal(12,2) @default(0)  // 0 in v1

  // Final
  grossPay          Decimal  @db.Decimal(12,2)
  netPay            Decimal  @db.Decimal(12,2)

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  lineItems         PayslipLineItem[]

  @@unique([payrollRunId, employeeProfileId])
}
```

### `PayslipLineItem` (allowance, deduction, claim reimbursement)

```prisma
model PayslipLineItem {
  id          String   @id @default(cuid())
  payslipId   String
  payslip     Payslip  @relation(...)

  kind        PayslipLineKind  // enum: ALLOWANCE | DEDUCTION | REIMBURSEMENT
  label       String           // "Travel Allowance" | "Late Penalty" | "Sept client lunch" (from claim title)
  amount      Decimal  @db.Decimal(12,2)

  // Reimbursements from Workpulse claims
  claimId     String?  @unique           // FK back to the original claim, nullable for manual line items
  claim       Claim?   @relation(...)

  // Statutory applicability (v1: hardcoded; v1.1: customizable)
  subjectToEpf    Boolean  @default(true)
  subjectToSocso  Boolean  @default(true)
  subjectToEis    Boolean  @default(true)
  subjectToPcb    Boolean  @default(true)

  createdAt   DateTime @default(now())
}
```

### New enums

```prisma
enum Gender { MALE FEMALE }
enum IdType { NRIC PASSPORT ARMY_NO POLICE_NO }
enum MaritalStatus { SINGLE MARRIED DIVORCED WIDOWED }
enum SocsoScheme { EMPLOYMENT_INJURY_INVALIDITY EMPLOYMENT_INJURY_ONLY }
enum SalaryType { MONTHLY HOURLY }
enum WorkingDaysRule { CALENDAR TWENTY_SIX }
enum PayrollRunStatus { DRAFT SUBMITTED }
enum PayslipLineKind { ALLOWANCE DEDUCTION REIMBURSEMENT }
```

---

## 4. Calculation logic reference (v1 only)

> All formulas in MYR. Rounding rules follow Malaysian payroll conventions
> as documented in the user's reference material.

### Basic pay

```
if salaryType === MONTHLY:
    basicPay = monthlySalary
else (HOURLY):
    basicPay = hourlyRate * workedHours    // workedHours entered manually in v1
```

### Hourly rate (used for OT)

```
if salaryType === HOURLY:
    hourlyRate = hourlyRate
else:
    hourlyRate = basicPay / workingDaysForRule / 8
```

Where `workingDaysForRule`:
- `CALENDAR`: number of calendar days in the month
- `TWENTY_SIX`: 26

### Overtime

```
otPay = (otNormalHours * hourlyRate * otRateNormal)
      + (otRestHours   * hourlyRate * otRateRest)
      + (otPublicHours * hourlyRate * otRatePublicHoliday)
```

OT is part of SOCSO + EIS + PCB wages. **OT is NOT part of EPF wage.**

### Proration (new joiner / leaver mid-month)

```
if joinDate is mid-month:
    workedDays = working days from joinDate to end-of-month
elif leaveDate is mid-month:
    workedDays = working days from start-of-month to leaveDate
else:
    workedDays = workingDaysForRule

proratedFactor = workedDays / workingDaysForRule
proratedPay = basicPay * proratedFactor
```

For `CALENDAR` rule, "working days" = calendar days (incl. weekends).
For `TWENTY_SIX` rule, "working days" = count weekdays only, capped at 26.

### EPF — Malaysian employee

Stepped wage rounding before applying rate:

```
def steppedEpfWage(wage):
    if wage <= 10:    return 0
    if wage <= 5000:  return ceil(wage / 20) * 20     // round up to nearest 20
    if wage <= 20000: return ceil(wage / 100) * 100   // round up to nearest 100
    return wage

epfWage = basicPay + allowances - unpaidLeaveDeduction   // OT NOT included
                                                           // Reimbursements NOT included
employeeEpf = steppedEpfWage(epfWage) * (employeeRate + employeeVoluntary) / 100

# employer rate: 13% if wage <= 5000, else 12% (mandatory)
employerMandatoryRate = (wage <= 5000) ? 13 : 12
employerEpf = steppedEpfWage(epfWage) * (employerMandatoryRate + employerVoluntary) / 100
```

### EPF — Foreign worker

If `nationality !== "Malaysian"`:

```
# Pre-effective-date: no EPF unless voluntary
# Post-effective-date (Oct 2025 per current Malaysian regulation):
#   2% mandatory employee + 2% mandatory employer
#   plus any voluntary top-up
```

v1 assumes post-effective-date (always 2% mandatory). Document this assumption — admin can override via the EPF rate fields per employee.

### SOCSO — wage bracket

Both schemes use the same wage bracketing:

```
def socsoWage(wage):
    if wage <= 30:    return 0
    capped = min(wage, 6000)
    # Use the assumed-wage bracket: ceil(capped / 100) * 100 minus 50
    return ceil(capped / 100) * 100 - 50
```

**First Category** (Employment Injury + Invalidity):
```
employerSocso = socsoWage * 0.0175       # 1.75%
employeeSocso = socsoWage * 0.005        # 0.5%
```

**Second Category** (Employment Injury only):
```
employerSocso = socsoWage * 0.0125       # 1.25%
employeeSocso = 0
```

Both rounded to nearest RM 0.05.

SOCSO wage base: `basicPay + allowances + OT - unpaidLeaveDeduction + reimbursements` (reimbursements excluded? — confirm with test data).

**For v1: reimbursements (Workpulse claims) NOT included in SOCSO/EIS/EPF wage base.** They're true reimbursements — pre-tax expenses paid back.

### EIS

```
def eisWage(wage):
    if wage <= 30:   return 0
    capped = min(wage, 6000)
    return ceil(capped / 100) * 100 - 50

employeeEis = eisWage * 0.002    # 0.2%
employerEis = eisWage * 0.002    # 0.2%
```

Both rounded up to nearest RM 0.05.

EIS wage base: same as SOCSO.

### Gross pay

```
grossPay = basicPay
         + totalAllowances
         + otPay
         + totalReimbursements
         - totalDeductions
         - unpaidLeaveDeduction
```

### Net pay (v1, no PCB)

```
netPay = grossPay
       - employeeEpf
       - employeeSocso
       - employeeEis
       # PCB = 0 in v1
```

### PCB (deferred to v2)

Captured here for future reference but **NOT IMPLEMENTED in v1**. All payslips show `pcb = 0` and a clear disclaimer that tax withholding is not yet automated.

---

## 5. Integration points

### Claims → Payroll

**Trigger:** Admin reviews and syncs a claim. Claim reaches status `SYNCED`. A new button "Add to Payroll" appears.

**Click flow:**

```
1. Admin clicks "Add to Payroll" on a SYNCED claim
2. Server checks if there's a DRAFT PayrollRun for the claim's org + current month
   - If yes: use it
   - If no: error "No draft payroll run for this month. Start one first."
3. Find the employee's Payslip in that draft run
   - If exists: add a PayslipLineItem of kind REIMBURSEMENT
   - If not: error "Employee not in this payroll run."
4. PayslipLineItem fields:
   - label: the claim's title
   - amount: the claim's approved amount
   - claimId: FK to the original Claim
   - subjectToEpf/Socso/Eis/Pcb: all FALSE (true reimbursement, not wages)
5. Recalculate the payslip totals
6. Mark the claim with a flag/status: "addedToPayroll: true" (new column on Claim OR new join table)
```

**Removability:** until the payroll run is submitted, admin can remove the line item. Removing it un-flags the claim so it can be added to a future run.

**Parallel to Xero sync:** the existing `syncClaim` flow stays. "Add to Payroll" is a separate, independent action. A claim can be both Xero-synced AND payroll-attached.

### Cache invalidation

New helper in `lib/cache-invalidation.ts`:

```ts
bustPayrollCaches({ organizationId, runId?, employeeProfileId? })
```

Sweeps:
- `org:{orgId}:payroll:*` (admin payroll list, settings page)
- `org:{orgId}:run:{runId}:*` (specific run's payslips list)
- `user:{userId}:payslips:*` (employee's own payslip history)

Called from every mutation in the payroll module.

---

## 6. Phased plan

### Phase 0 — Review reference data + finalize schema (1 session)

**Goal:** Confirm field types match what the user actually has, before writing migrations.

- [ ] Read `Employees (5).xlsx` — verify field names and types match the proposed `PayrollProfile` schema
- [ ] Read `Payroll_Summary_January_2026.pdf` + `February_2026.pdf` — verify output format and line items match the proposed `Payslip` schema
- [ ] Adjust schema based on findings (rename fields, add missing ones, drop unused)
- [ ] Lock final schema design with user
- [ ] Write Prisma migration (additive only — no changes to existing tables)
- [ ] Generate Prisma client

**Deliverable:** finalized `schema.prisma` additions + this plan doc reviewed.

### Phase 1 — Employee personal + statutory UI (2 sessions)

**Goal:** Admin can fill in payroll-specific data for each employee.

- [ ] `modules/payroll/domain/models.ts` — shared types
- [ ] `modules/payroll/infrastructure/payroll-profile.repository.ts` — CRUD on PayrollProfile
- [ ] `modules/payroll/application/services/payroll-profile.service.ts`
- [ ] `app/(admin)/admin/payroll/employees/page.tsx` — list employees with their payroll profile completion state
- [ ] `app/(admin)/admin/payroll/employees/[id]/page.tsx` — tabs: Personal / Employment / Statutory / Payslips
- [ ] Personal tab: name, phone, gender, DOB, nationality, ID type/no, marital, resident, OKU, child relief
- [ ] Employment tab: position (from EmployeeProfile), join date, salary type, monthly salary OR hourly rate, fixed allowances
- [ ] Statutory tab: EPF toggle + rates, SOCSO scheme + number, EIS toggle, income tax no, bank details
- [ ] Server actions for each tab's form
- [ ] Validation (Zod schemas)

**Deliverable:** admin can onboard an employee into payroll. Test against the user's Excel data.

### Phase 2 — Company payroll settings UI (1 session)

**Goal:** Admin can configure org-wide payroll rules + employer filing profile.

Two separate tables, two separate concerns:
- `PayrollSettings` — operational rules (rates, multipliers, working-days)
- `PayrollCompanyInfo` — employer filing profile (Form E)

UI presents both via tabs on the same settings page, but they save independently.

- [ ] `modules/payroll/infrastructure/payroll-settings.repository.ts`
- [ ] `modules/payroll/infrastructure/payroll-company-info.repository.ts`
- [ ] `modules/payroll/application/services/payroll-settings.service.ts`
- [ ] `modules/payroll/application/services/payroll-company-info.service.ts`
- [ ] `app/(admin)/admin/payroll/settings/page.tsx` — top-level page with two tabs
- [ ] **General tab** (writes `PayrollSettings`): OT rates, working days rule, default EPF rates, HRDF enabled+rate, Employer ID, MyCo/SSM, leave carry-forward rules (placeholder)
- [ ] **Form E tab** (writes `PayrollCompanyInfo`): employer name/TIN/registration/reference, category/status, CP8D, correspondence (address, country, phone, email), tax agent block, declarant block
- [ ] Server actions for each tab's form
- [ ] Validation (Zod)

**Deliverable:** both settings tables editable. Form E tab is captured even though filing flow is deferred — fields are needed before any payroll calc references them.

### Phase 3 — Payroll run shell (2 sessions)

**Goal:** Admin can create a draft payroll run for a given month and see all eligible employees in a list with their basic pay computed.

- [ ] `modules/payroll/infrastructure/payroll-run.repository.ts`
- [ ] `modules/payroll/infrastructure/payslip.repository.ts`
- [ ] `modules/payroll/application/services/payroll-run.service.ts`
- [ ] `modules/payroll/application/services/payslip.service.ts`
- [ ] `app/(admin)/admin/payroll/page.tsx` — overview: current run + history list
- [ ] `app/(admin)/admin/payroll/runs/new/page.tsx` — "Select Payroll Period" (year + month)
- [ ] `app/(admin)/admin/payroll/runs/[id]/page.tsx` — list of employee payslips in the run
- [ ] Create-run server action: spawns one Payslip per active employee with basic pay populated
- [ ] Show: name, position, salary type, basic pay, proration factor, draft/submitted state

**Deliverable:** admin can create a draft run and see the employee list, before any statutory calc.

### Phase 4 — Calculation engine (3 sessions)

**Goal:** Compute all v1 numbers (basic + OT + allowances + EPF + SOCSO + EIS) per payslip.

- [ ] `modules/payroll/domain/calculations.ts` — pure functions:
  - [ ] `prorateBasic(salary, joinDate, leaveDate, periodStart, periodEnd, rule) → { proratedPay, factor }`
  - [ ] `calcOvertime(hourly, hours, rates) → otPay`
  - [ ] `calcEpf(wage, isMalaysian, employeeRate, employerRate, employeeVoluntary, employerVoluntary) → { employee, employer }`
  - [ ] `calcSocso(wage, scheme) → { employee, employer }`
  - [ ] `calcEis(wage) → { employee, employer }`
  - [ ] `composePayslip({ profile, otHours, allowances, deductions, reimbursements, periodMonth, periodYear }) → Payslip`
- [ ] Unit tests against the user's expected outputs (test set TBD)
- [ ] `app/(admin)/admin/payroll/runs/[id]/page.tsx` — per-employee row expanded with all numbers
- [ ] Per-employee edit form: enter OT hours, ad-hoc allowances, ad-hoc deductions
- [ ] Recalculate on every edit
- [ ] Show full breakdown: basic, OT, allowances, deductions, statutory, gross, net

**Deliverable:** working draft payroll run with correct numbers for all sample employees in the test set.

### Phase 5 — Claims → Payroll integration (2 sessions)

**Goal:** SYNCED claims can be attached to a draft run as reimbursement line items.

- [ ] Add `addedToPayrollAt: DateTime?` column to `Claim` (nullable; non-null = already added)
- [ ] Server action: `addClaimToPayrollAction(claimId)`
  - validate claim is SYNCED
  - find draft run for the org + current month (error if none)
  - find or create payslip for the employee
  - create `PayslipLineItem` with kind=REIMBURSEMENT, subjectToEpf/Socso/Eis/Pcb=FALSE
  - update payslip totals
  - mark claim as added
- [ ] Server action: `removeClaimFromPayrollAction(claimId)`
  - validate draft run is still DRAFT
  - delete the PayslipLineItem
  - update payslip totals
  - un-mark claim
- [ ] UI: "Add to Payroll" button on admin claims table for SYNCED rows; replaced with "Remove from Payroll" once added
- [ ] UI: payslip detail view lists reimbursement line items separately from allowances

**Deliverable:** end-to-end: admin syncs a claim → clicks Add to Payroll → claim appears on the employee's payslip → can be removed before submit.

### Phase 6 — Submit + finalize + employee view (2 sessions)

**Goal:** Admin can lock the run and employees can see their payslips.

- [ ] Submit action: PayrollRun.status → SUBMITTED, submittedAt = now, compute run-level totals
- [ ] After submit: payslips become read-only; further changes require revert
- [ ] Revert action: status → DRAFT (only allowed if no later run is submitted)
- [ ] `app/(employee)/employee/payslips/page.tsx` — employee's own payslip list (year filter)
- [ ] `app/(employee)/employee/payslips/[id]/page.tsx` — single payslip view
- [ ] Permissions: employee sees only their own; admin sees all in their org

**Deliverable:** end-to-end payroll for one month, fully usable by admin + employee.

---

## 7. Files to create

### Schema
- `prisma/schema.prisma` (additions: 5 models + 7 enums)
- `prisma/migrations/...` (auto-generated)

### Domain
- `modules/payroll/domain/models.ts`
- `modules/payroll/domain/calculations.ts`

### Application
- `modules/payroll/application/services/payroll-profile.service.ts`
- `modules/payroll/application/services/payroll-settings.service.ts`
- `modules/payroll/application/services/payroll-company-info.service.ts`
- `modules/payroll/application/services/payroll-run.service.ts`
- `modules/payroll/application/services/payslip.service.ts`

### Infrastructure
- `modules/payroll/infrastructure/payroll-profile.repository.ts`
- `modules/payroll/infrastructure/payroll-settings.repository.ts`
- `modules/payroll/infrastructure/payroll-company-info.repository.ts`
- `modules/payroll/infrastructure/payroll-run.repository.ts`
- `modules/payroll/infrastructure/payslip.repository.ts`

### Admin UI
- `app/(admin)/admin/payroll/page.tsx` (overview)
- `app/(admin)/admin/payroll/actions.ts`
- `app/(admin)/admin/payroll/settings/page.tsx`
- `app/(admin)/admin/payroll/settings/actions.ts`
- `app/(admin)/admin/payroll/employees/page.tsx`
- `app/(admin)/admin/payroll/employees/[id]/page.tsx`
- `app/(admin)/admin/payroll/employees/[id]/actions.ts`
- `app/(admin)/admin/payroll/runs/page.tsx`
- `app/(admin)/admin/payroll/runs/new/page.tsx`
- `app/(admin)/admin/payroll/runs/[id]/page.tsx`
- `app/(admin)/admin/payroll/runs/[id]/actions.ts`

### Components
- `components/admin/payroll-profile-form.tsx`
- `components/admin/payroll-settings-form.tsx`
- `components/admin/payroll-run-table.tsx`
- `components/admin/payslip-detail.tsx`
- `components/employee/employee-payslip-view.tsx`

### Employee UI
- `app/(employee)/employee/payslips/page.tsx`
- `app/(employee)/employee/payslips/[id]/page.tsx`

### Claims integration
- Modify `app/(admin)/admin/claims/actions.ts` — add `addClaimToPayrollAction` + `removeClaimFromPayrollAction`
- Modify `components/admin/admin-claims-table.tsx` (or wherever the action buttons live) — new button for SYNCED rows

### Cache invalidation
- Modify `lib/cache-invalidation.ts` — add `bustPayrollCaches`

---

## 8. Open questions / risks

1. **Test set for verifying calculations.** User to provide expected outputs from Altomate for specific employees. Without this, EPF stepped-wage rounding and SOCSO bracketing might be subtly off.

2. **Statutory rate updates.** All rates hardcoded for 2026 (EPF 11%/13%/12%, SOCSO 1.75%/0.5%/1.25%, EIS 0.2%, ceiling RM6,000). When Malaysian rates change yearly, requires a code update. Acceptable for v1; revisit if it becomes a maintenance burden.

3. **Bank account PII.** `bankAccountNumber` stored in plaintext. v1 acceptable. v1.1 should encrypt at rest.

4. **Foreign worker EPF effective date.** Implementation assumes post-effective-date (2% mandatory). If user has pre-effective foreign workers, admin will need to set their EPF rate to 0% manually.

5. **Unpaid leave deductions** — currently `unpaidLeaveDeduction = 0` always (leave module not built). Field exists for v2.

6. **Worked hours for HOURLY employees** — manually entered by admin in v1 (no attendance integration). Admin fills it in per payslip.

7. **What happens if you try to start a run for a month that already has a SUBMITTED run?** Error. Only one run per (org, year, month) — enforced by `@@unique`.

8. **Multiple drafts at once?** Allowed — one draft per future month. The unique constraint prevents duplicates for the same period.

---

## 9. Sequencing

Each phase ends with a working, testable deliverable. After each phase ends, **stop and verify** before starting the next. No phase touches more than the phases before it.

```
Phase 0: schema + reference review        ────► 1 session
Phase 1: employee profile UI              ────► 2 sessions
Phase 2: payroll settings UI              ────► 1 session
Phase 3: run shell                        ────► 2 sessions
Phase 4: calculation engine               ────► 3 sessions
Phase 5: claims integration               ────► 2 sessions
Phase 6: submit + employee view           ────► 2 sessions
                                                ────────
                                                ~13 sessions
```

Concrete time at typical pace: **3 weeks of focused work** for v1 end-to-end.

---

## 10. Out of scope for this plan

- PCB (planned for v2, separate doc when we get there)
- Form E filing flow (capture fields in Phase 2; build filing UI later)
- PDF generation (v1.1)
- Allowance category matrix (v1.1)
- Leave + attendance integration (v2)
- HRDF (v2)
- Multi-country (v3+)
- Test framework setup (we'll need one before Phase 4 — verifies calculations against the user's test set; covered in Phase 4 prep)

---

## 11. Approval checklist

Before starting Phase 0, confirm:

- [ ] Scope decisions in section 1 are correct
- [ ] Schema design in section 3 is approximately right (Phase 0 will refine after seeing uploaded files)
- [ ] Calculation formulas in section 4 match what Altomate produces
- [ ] Claims → Payroll flow in section 5 matches the intended UX
- [ ] Phase order in section 6 is acceptable
- [ ] Test set is available before Phase 4 starts

Once all 6 are ✓, we begin Phase 0.
