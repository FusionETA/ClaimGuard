# Organization module — context for Claude

This file is auto-loaded when Claude touches anything under
`modules/organization/`. See the repo-wide `/CLAUDE.md` for the layered
architecture rule.

## What lives here

The organisation module owns three loosely-related aggregates:

1. **Organization** — company profile, OT rates, claim run cutoff,
   working hours, geofence radius, mileage defaults.
2. **ChartOfAccount** — both Xero-synced and custom (manual) accounts.
   Distinguished by `isCustom` and `xeroConnectionId`. Same row stores the
   selectable / bank / mileage / limit flags.
3. **XeroConnection / XeroProject** — OAuth tokens per tenant + project
   pull. The hand-rolled Xero HTTP client lives in `lib/xero.ts`.

## Domain types

- `OrganizationSummary` — name, claimCutoffDay, otRates, defaultMileageRate,
  mileageUnit. Returned by `mapOrganizationSummary`.
- `ChartOfAccountOption` — single source of truth for the COA view-model.
  Includes the spend-limit fields (`limitAmount`, `limitPeriod`, `limitScope`)
  and the mileage flags (`allowMileageClaim`, `mileageRate`).
- `LimitPeriod` (`PER_CLAIM | MONTHLY | YEARLY`),
  `LimitScope` (`PER_EMPLOYEE | ORG_WIDE`),
  `MileageUnit` (`KM | MILE`),
  `EmployeePayoutMethod` (`HOURLY | MONTHLY_BASED`).
- `XeroConnectionInfo`, `XeroConnectionSummary` — `getXeroConnectionSummary`
  bundles config-status, missing-config errors, and the list of connections.

## The chart-of-account mapper

`infrastructure/chart-account.mapper.ts` exports `mapChartAccount(row)` and
the `ChartAccountRow` input type. Both `organization.repository.ts` and
`claim.repository.ts` import from it. **There is no second mapper.** Adding
a new column to `ChartOfAccount` means updating this mapper + the
`ChartOfAccountOption` type, nothing else.

## Selectable vs Bank vs Mileage

All three are flags on the same `ChartOfAccount` row, edited from the
**Accounts** settings tab via three separate sub-pills:

- `isSelectable` — appears in the employee claim form when `claimType =
  EXPENSE`. Bulk-set via `setSelectableChartAccounts`.
- `isBankAccount` — appears as a "paid via" option for COMPANY-money claims.
  Bulk-set via `setSelectedBankAccounts`. Filtered separately by
  `getBankAccountsForOrganization`.
- `allowMileageClaim` — appears in the employee claim form when `claimType =
  MILEAGE`. Bulk-set via `setMileageChartAccounts`, which also writes the
  per-account rate override.

When a single account is queried by id, the `forClaimType` parameter on
`getChartAccountByIdForOrganization({ chartOfAccountId, forClaimType })`
chooses which flag to validate against (`isSelectable` for EXPENSE, or
`allowMileageClaim` for MILEAGE).

## Spend limits

- `updateChartAccountLimit({ chartOfAccountId, limitAmount, limitPeriod, limitScope })`
  — passing `undefined` for any of the three clears the entire limit
  (sets all three columns to null). The settings UI exposes a "Remove
  limit" button that submits the form with empty values to trigger this.
- For sum/aggregate queries used during limit checks, see the claims
  module's `claim.repository.ts` (`sumClaimsForLimit`,
  `sumClaimsByAccountForLimits`).

## Xero specifics

- `lib/xero.ts` is a hand-rolled fetch client (no SDK). The OAuth callback
  lives at `app/api/xero/callback/route.ts`. Token refresh happens lazily
  in the API client.
- `getXeroConnectionSummary(orgId)` returns `{ configured, missingConfig,
  connections }`. `configured: false` means env vars are missing — the
  caller renders a "set XERO_CLIENT_ID" hint. Always check it before
  rendering connection-related UI.
- Multi-tenant: a single Xero login can return multiple tenants. The
  callback stashes them in a short-lived `claimguard_xero_pending` cookie
  and redirects to `?xero=select-tenant`.

## Don't

- Don't define a new `mapChartAccount` mapper.
- Don't query `prisma.chartOfAccount.findMany(...)` from a service — add a
  repo method.
- Don't add new free-string columns where an enum or FK would do (the
  schema has too many of these already; see the repo-wide CLAUDE.md).
- Don't forget that custom (no-Xero) and Xero-synced accounts coexist in
  the same table. Most queries scope by `xeroConnectionId` (NULL for
  custom).
