# modules/payroll/ — context for Claude

Malaysian-statutory payroll. The most domain-heavy module in the repo —
PCB (Potongan Cukai Bulanan), EPF, SOCSO, EIS, HRDF, and the Xero sync
that turns each run into Manual Journals + Spend Money entries.

## Layers

- **domain/** — pure, well-tested. The PCB and statutory tables are
  driven by LHDN's published schedules; they live here so the math can
  be reasoned about and unit-tested without touching the DB.
  - `calc.ts` — gross → net pay computation for one employee for one run.
  - `pcb.ts` — monthly tax deduction tables.
  - `statutory-tables.ts` — EPF / SOCSO / EIS / HRDF rates by category.
  - `runs.ts` — run state machine + period helpers (`periodLabel`, etc.).
  - `loans.ts` — instalment scheduling math for employee loans.
  - `annual-reports.ts`, `reports.ts` — pure shape transforms for the
    EA, CP8D, and Form E annual filings.
  - `salary-change.ts` — pure math for proration when a salary changes
    mid-cycle.
  - `__tests__/` — vitest unit tests. **Keep these green.** They cover
    PCB and statutory edge cases that real users hit every payroll cycle.
- **application/services/**
  - `payroll-run.service.ts` — orchestrates an end-to-end run: lock the
    period, compute each employee, write rows, freeze the snapshot.
  - `payroll-profile.service.ts` — per-employee payroll profile (basic
    salary, allowances, category).
  - `payroll-settings.service.ts` — org-level payroll settings (PCB
    category, EPF rates, etc.).
  - `payroll-reports.service.ts` / `payroll-annual-reports.service.ts`
    — payslip + annual filing generation, calls `report-renderers/`.
  - `payroll-import.service.ts` — bulk-import employees from XLSX.
  - `xero-payroll-sync.service.ts` / `xero-sync-preview.service.ts` —
    pushes journal + spend entries to Xero, with a preview pass first
    so the admin can sanity-check before committing.
  - `employee-payroll.service.ts` — payslip page data for the employee
    portal (`getEmployeePayslipsPageData`).
  - `loan.service.ts` — employee loan CRUD + repayment scheduling.
- **infrastructure/** — twelve repository files, one per aggregate.
  All Prisma access lives here.

## Conventions

- Money is `Decimal(12, 2)` everywhere. Always `toNumber()` before
  arithmetic; never `Number(decimal)`.
- A "run" is **immutable once locked**. Re-running a locked period must
  go through `payroll-run.service.ts` (unlock → recompute → re-lock).
- Payslip snapshots store the rates that applied at the time —
  changing org rates afterwards must NOT mutate historical payslips.
- Xero sync is idempotent on the run id. If the call partially fails,
  the next attempt skips entries that already landed.

## Don't

- Don't change a statutory rate in code — it belongs in
  `statutory-tables.ts` with a comment citing the LHDN circular date.
- Don't `await prisma.payrollRun.update` from a service that isn't the
  run service — concurrent run mutation is a footgun.
- Don't compute PCB inline. Always call `computeMonthlyPCB(...)` from
  `domain/pcb.ts`.
- Don't render PDFs in a route handler — the `@react-pdf/renderer`
  pipeline lives in `report-renderers/` and is invoked from services.
