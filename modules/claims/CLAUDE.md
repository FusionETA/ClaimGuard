# Claims module — context for Claude

This file is auto-loaded when Claude touches anything under `modules/claims/`.
See the repo-wide `/CLAUDE.md` for the layered architecture rule and shared
helpers.

## Domain types worth knowing

- `ClaimStatus` — `SUBMITTED | PENDING | APPROVED | REJECTED | PAID | SETTLED`.
  `SUBMITTED` is folded into `PENDING` for UI filtering — always use
  `claimMatchesStatusFilter(claim, filter)` and `visibleStatusOptions` from
  `domain/models.ts`.
- `ClaimType` — `EXPENSE | MILEAGE`. Determines which form fields are required
  and which `ChartOfAccount` set the employee can pick from.
- `ClaimRecord` is the view-model returned by `mapClaim`. It carries the
  full mileage snapshot (`distance`, `mileageOriginAddress`,
  `mileageDestinationAddress`, `mileageRateUsed`, `mileageUnitUsed`) for
  mileage claims. Don't read these from the bare Prisma row.
- `decideNextClaimStatus({ decision, isFinalStep, isCompanyMoney })` is the
  single source of truth for the approval state machine. **Do not** open-code
  the branches anywhere else.

## Approval state machine

```
SUBMITTED → PENDING → APPROVED → PAID
                        ↘    ↘
                          SETTLED   (when paymentType === COMPANY)
                        ↘
                       REJECTED
```

Rules (encoded in `decideNextClaimStatus`):

- `REJECTED` → stays `REJECTED`.
- `APPROVED` mid-chain → `PENDING` (next layer).
- `APPROVED` final step + PERSONAL → `APPROVED` (admin still marks paid).
- `APPROVED` final step + COMPANY → `SETTLED` (auto-finalised; no payout step).

The `reviewClaim` repo method dispatches to three branches (chain mid-step,
chain legacy, admin review) but they all share the same `decideNextClaimStatus`
call — adding a new transition rule means editing exactly one function.

## Limit + mileage features

- `ChartOfAccount` carries optional flags: `limitAmount`, `limitPeriod`,
  `limitScope`, `allowMileageClaim`, `mileageRate`. Read them via the canonical
  `mapChartAccount` from `modules/organization/infrastructure/chart-account.mapper.ts`.
- Limit checks: `checkClaimAccountLimit({ account, employeeId, amount, spentAt })`
  in `application/services/claim-workflow.service.ts`. Returns a discriminated
  union — caller branches on `result.ok`.
- For the **employee form's "X used of Y remaining" hints**, do NOT call
  `getRemainingLimit` per account. Use the batched
  `claimRepository.sumClaimsByAccountForLimits({ accountIds, periodStart,
  periodEnd, employeeId? })` and group by `(period, scope)` bucket. The
  service `decorateAccountsWithLimits` in `employee-portal.service.ts` is the
  reference implementation.
- Mileage rate resolution: `resolveMileageRate({ organization, account })`
  from `lib/mileage.ts`. Per-account `mileageRate` overrides
  `Organization.defaultMileageRate`. The unit is org-level
  (`Organization.mileageUnit`).
- The mileage snapshot fields (`mileageRateUsed`, `mileageUnitUsed`) on
  `Claim` exist so historical claims don't change when the admin later edits
  the rate. Always set them on submission, never read the live rate when
  displaying historical claims.

## Service / repo split

- `claim-workflow.service.ts` — claim creation, listing, supervisor review.
- `employee-portal.service.ts` — employee-facing dashboard + claim
  submission data. Hits a small in-memory store (`lib/app-store.ts`).
- `admin-portal.service.ts` — admin dashboard + claim queue. Same store.
- `admin-executive-overview.service.ts` — the executive-overview page.
  Orchestrates 9 repository methods from
  `infrastructure/executive-overview.repository.ts` and aggregates in JS.
- `admin-page-data.service.ts` — `getAdminClaimsPageData`,
  `getAdminHierarchyPageData`, `getAdminSettingsPageData`. **Pages call
  these, not repositories.**
- `claim.repository.ts` — all `prisma.claim.*` and `prisma.user.*` for the
  claims domain. Includes `getClaimNotificationSnapshot` (lightweight lookup
  for push notifications), `sumClaimsForLimit` / `sumClaimsByAccountForLimits`
  (limit math), `countPendingForSupervisor` (count-only — does not hydrate
  claims).
- `executive-overview.repository.ts` — the 9 queries that feed the
  executive overview. Each method has a typed `Exec*Row` return shape.

## Form pipeline

The employee claim form flow:

1. `app/(employee)/employee/claims/new/claim-form.tsx` — controlled inputs.
   Tracks `claimType`, `amountInput`, `distance`, etc. Computes
   `computeMileageAmount` live for the preview.
2. `app/(employee)/employee/claims/new/actions.ts` — converts FormData into
   the discriminated-union shape Zod expects, calls
   `createClaimForEmployee`. Receipt file upload happens here too.
3. `claim-workflow.service.ts` → `createClaimForEmployee`:
   - Re-runs the same Zod validation (server-trust boundary).
   - Loads the account via `getChartAccountByIdForOrganization({ forClaimType })`
     so MILEAGE claims resolve mileage-eligible accounts only.
   - Resolves mileage rate, computes amount, snapshots used rate/unit.
   - Runs `checkClaimAccountLimit` before insert.
   - Calls `claimRepository.createClaim(...)`.

## Don't

- Don't add `prisma.*` calls to any service file. If you need a query, add
  it to `claim.repository.ts` (or `executive-overview.repository.ts` if
  it's an analytics query).
- Don't reimplement the SUBMITTED↔PENDING fold inline. Use
  `claimMatchesStatusFilter`.
- Don't reimplement the approval state machine inline. Use
  `decideNextClaimStatus`.
- Don't pass the live mileage rate to the DB on insert — always use the
  resolved rate from `resolveMileageRate` and snapshot it as
  `mileageRateUsed`.
