# prisma/ — context for Claude

## Files

- `schema.prisma` — single schema, all models + enums.
- `seed.ts` — sample admins, orgs, sample claims. Run with `npm run db:seed`.
- `backfill-organization.ts` — one-off migration helper used during the
  initial multi-tenant rollout.
- `prisma.config.ts` (root) — Prisma config; `generated/prisma` is the
  output dir for the client.

## Workflow

```
npm run db:generate     # regenerate the client after schema changes
npm run db:push         # push schema → DB without generating a migration (dev)
npm run db:migrate      # generate a migration (use this in prod)
npm run db:seed         # seed sample data
```

After any schema change: regenerate the client (`db:generate`) before
running `tsc`, otherwise the generated types won't match.

## Schema gotchas (the ones that bite)

- **`Claim.amount` is `Decimal(12, 2)`**. Other Decimals: `limitAmount`
  (12, 2), `mileageRateUsed` (10, 4), `defaultMileageRate` (10, 4),
  `mileageRate` per-account (10, 4). Always coerce to JS number with
  `toNumber()` from `lib/decimal.ts`.
- **Loose strings instead of FKs/enums**:
  - `XeroConnection.provider` (always `"xero"`)
  - `ChartOfAccount.type` (`"BANK"` is checked as a magic string in 4+
    places — defining `BANK_ACCOUNT_TYPE` constant would help)
  - `EmployeeProfile.project` (mapped to `department` in DB, also
    duplicated as a free string on `AttendanceRecord.project` and
    `ApprovalRequest.project`). New code should prefer the FK
    relationships (`projectId` on attendance, `projectAssignments` on
    employeeProfile).
- **Custom + Xero accounts coexist** in `ChartOfAccount`. Custom rows
  have `xeroConnectionId = null` and `isCustom = true`. Most queries
  scope by `xeroConnectionId` (or the lack of one).
- **`PayoutMethod` was enum-ified** from a free string. If the DB has
  any rows with `payoutMethod` outside `HOURLY` / `MONTHLY_BASED`,
  normalise them before `db:push` accepts the change. (The previous
  `DAILY_BASED` value was renamed to `MONTHLY_BASED` in 2026-05.)

## When to add what

- New domain object → new model + enum if applicable. Update the relevant
  module's `domain/models.ts`, then the repository mapper.
- New flag on existing model → just a new column. The mapper picks it up.
  If it's on `ChartOfAccount`, update
  `modules/organization/infrastructure/chart-account.mapper.ts` (single
  source of truth for the COA mapper).
- New status / type → enum, not free string. Add it to the Prisma schema
  AND to the matching const-array in `domain/models.ts`.

## Don't

- Don't add a free-string column where an enum or FK would do.
- Don't bump a Decimal precision without thinking about whether old rows
  fit (it's safe to widen, narrowing requires a backfill).
- Don't edit `generated/prisma/` by hand. It's auto-generated.
