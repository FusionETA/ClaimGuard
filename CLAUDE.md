# AltomateHR — repo-wide context for Claude

This file is auto-loaded by Claude Code in every conversation in this repo.
Per-module instructions live in `modules/<module>/CLAUDE.md` and are loaded
when Claude touches files in that area.

## Stack & layered architecture

Next.js 15 (App Router) + TypeScript + Prisma (MariaDB) + Tailwind + shadcn-ui.
Iron-session auth, Web Push (PWA), hand-rolled Xero OAuth.

The app follows a **DDD-lite layered structure** inside `modules/`:

- **Domain** (`modules/<m>/domain/models.ts`) — pure TypeScript types and
  pure helper functions. No external imports beyond other domain modules.
- **Application / services** (`modules/<m>/application/services/*.ts`) —
  orchestration only. Uses repositories + other services. Validates input
  with Zod. No raw `prisma.*` calls.
- **Infrastructure / repositories** (`modules/<m>/infrastructure/*.repository.ts`)
  — all Prisma access lives here. One repo file per aggregate.

**Hard rules (don't violate):**

1. Pages and API routes call **services only**, never repositories or Prisma
   directly. If a page needs data, add a `getXxxPageData()` service in
   `modules/claims/application/services/admin-page-data.service.ts` (or the
   equivalent for other surfaces) and have the page call that.
2. Services call **repositories only**, never Prisma directly.
3. Anything `import "server-only"` cannot be imported from a client
   component. Pure helpers (e.g. `lib/mileage.ts`, `lib/decimal.ts`) live
   outside the server-only boundary so both sides can use them.

## Helpers you should reach for first

Before writing a new helper, check whether one of these already exists:

- `lib/decimal.ts` → `toNumber(value, fallback?)` — coerce a Prisma `Decimal`
  (which the MariaDB adapter returns as a wrapper object) to a JS number.
- `lib/utils.ts` → `cn`, `formatCurrency`, `formatShortDate`, `formatMonthLabel`,
  `formatMonthYear`, `buildInitials`.
- `lib/mileage.ts` → `computeMileageAmount({ distance, rate })`,
  `resolveMileageRate({ organization, account })`. Pure, safe on the client.
- `lib/auth/session.ts` → `getCurrentSession`, `requirePortalSession(role)`
  (redirects), `requireSessionForRole(role)` (returns discriminated union),
  `resolveActiveOrgId(session)` (active company ?? home org).
- `lib/form-state.ts` → `BaseFormState`, `FormState<V, E>` for new server actions.
- `components/ui/toaster.tsx` → `useToastOnAction(state)` — replaces the
  `useEffect(() => { if (success) toast(...); if (error) toast(...) })` pattern.
- `components/ui/coming-soon-card.tsx` → `<ComingSoonCard title body />` for
  unfinished feature placeholders.
- `modules/organization/infrastructure/chart-account.mapper.ts` →
  `mapChartAccount(row)`. **Both** repos import from here. Don't redefine.
- `modules/claims/domain/models.ts` → `claimMatchesStatusFilter(claim, filter)`,
  `visibleStatusOptions`, `decideNextClaimStatus({ decision, isFinalStep, isCompanyMoney })`.

## Form actions

Server actions live next to the page that uses them, e.g.
`app/(admin)/admin/settings/actions.ts`. They:

1. Check the session (`getCurrentSession`, role check).
2. Pull form values, validate with Zod.
3. Call a service or repository method.
4. Call `revalidatePath(...)` for any affected route.
5. Return a `FormState`-shaped result.

The form component uses `useActionState` + `useToastOnAction(state)`. Don't
write a `useEffect` for toast feedback — use the hook.

## Schema gotchas

- Many statuses live as **enums** in `prisma/schema.prisma` — `ClaimStatus`,
  `ClaimType`, `LimitPeriod`, `LimitScope`, `MileageUnit`, `PayoutMethod`,
  `AttendanceStatus`, `ApprovalKind`, etc. Use them.
- Several columns are still loose strings for legacy reasons:
  `XeroConnection.provider` (always "xero"), `ChartOfAccount.type`
  (`"BANK"` is a magic string in 4+ places), `EmployeeProfile.project`
  (mapped to `department` in the DB and duplicated on `AttendanceRecord` /
  `ApprovalRequest`). Don't add new free-string columns where an enum or
  FK would do.
- `Claim.amount` is `Decimal(12, 2)`. `ChartOfAccount.limitAmount` and
  `Organization.defaultMileageRate` are also Decimals — always coerce with
  `toNumber()` before doing arithmetic.

## Workflow expectations

- After making a meaningful change, run `npx tsc --noEmit --incremental false`
  to verify. There is no test suite — `tsc` + manual click-through is the
  full verification loop.
- Commit with a Conventional Commits message
  (`feat:`, `fix:`, `refactor:`, `chore:`).
- Never bypass the layered structure with a "quick" Prisma call from a page
  or service — even if it's "just one query". Add a repo method instead.

## Don't

- Don't use `localStorage` / `sessionStorage` (browser storage is fine in
  React state for the current session, but never persisted to the browser).
- Don't write a one-off Decimal coercion (`Number(prismaDecimal)`) — use
  `toNumber()`. Number() loses precision above 2^53.
- Don't define a new `mapChartAccount` mapper or copy `buildInitials` /
  `toNumber` / `useToastOnAction` / `claimMatchesStatusFilter` into a new
  file. They exist; import them.
- Don't put `import "server-only"` modules in `lib/` — `lib/` is the
  shared client+server zone.
- Don't auto-fold `SUBMITTED` and `PENDING` statuses inline. Use
  `claimMatchesStatusFilter`.
- Don't reach for `localStorage` to remember an admin's selected org — use
  the session (`activeOrganizationId`) and `resolveActiveOrgId(session)`.

## Recent context (for sessions starting cold)

- The `Mileage claims` and per-account `Spend limits` features were added
  on top of `ChartOfAccount` via additive flags (`allowMileageClaim`,
  `mileageRate`, `limitAmount`, `limitPeriod`, `limitScope`). The
  `ClaimType` enum (`EXPENSE | MILEAGE`) lives on `Claim`. Mileage claims
  snapshot `mileageRateUsed` + `mileageUnitUsed` so historical claims
  don't change when the admin updates the rate later.
- The settings sidebar was collapsed from 7 → 4 top-level tabs:
  Organization, Accounts (with sub-pills: Selectable / Banks / Mileage),
  Projects, Attendance, Leave. Backwards-compat for old `?tab=` deep links
  is handled in `resolveTabFromInitial()` in `admin-settings-panel.tsx`.
- The push-notification subscriptions live in
  `modules/notifications/infrastructure/push-subscription.repository.ts`,
  not directly in the API routes.
