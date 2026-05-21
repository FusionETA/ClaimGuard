# modules/leave/ — context for Claude

Leave management: applications, balances, entitlements, accrual, and the
two cron jobs that keep entitlements in sync.

## Layers

- **domain/**
  - `models.ts` — `LeaveTypeView`, `LeaveApplicationView`, status enums,
    pure helpers for status transitions.
  - `accrual.ts` — pure math for pro-rated accrual and carry-forward
    expiry. No DB access.
- **application/services/**
  - `leave-application.service.ts` — submit / cancel / approve / reject
    workflow. Pulls approval chain via `leave-approval-context.ts`.
  - `leave-balance.service.ts` — current-balance composition (entitled +
    carried − used − pending).
  - `leave-cron.service.ts` — `runMonthlyAccrual` and `runYearRollover`,
    called by `/api/cron/leave-monthly-accrual` and
    `/api/cron/leave-year-rollover`. Idempotent — safe to re-run.
  - `leave-defaults.service.ts` — resolves entitled days via the chain:
    employee override → policy default → leave-type default.
  - `leave-entitlements.service.ts` — `listEmployeeBalances`, used by
    the employee dashboard and the leave page.
  - `leave-overview.service.ts` — admin-facing aggregate views.
  - `leave-types.service.ts` — CRUD for leave types.
- **infrastructure/**
  - `leave-repository.ts` — all Prisma access. Returns Decimal-safe
    shapes via `toNumber()`.
  - `leave-approval-context.ts` — builds the approval chain for a given
    employee + leave type (reused by service + cron).
  - `leave-attachment-storage.ts` — file save/serve for leave
    attachments (medical certs, etc.).

## Conventions

- Half-day leave is modeled as `0.5` on the `days` Decimal field; never
  store fractions other than `0.5` or `1`.
- `carriedExpiresAt` is the **inclusive last day** the carried days can
  be used. The accrual cron sweeps anything strictly past this date.
- The default resolution chain (employee → policy → type) is the single
  source of truth. Don't hard-code defaults in pages — always go
  through `leave-defaults.service.ts`.

## Don't

- Don't bypass `leave-cron.service.ts` and write your own accrual loop.
- Don't `prisma.leaveApplication.update` from a page or action — go
  through `leave-application.service.ts` so the approval-chain side
  effects fire.
- Don't store `entitledDays` directly on the `User` — it lives on
  `EmployeePolicy` or on `LeaveTypeOverride`.
