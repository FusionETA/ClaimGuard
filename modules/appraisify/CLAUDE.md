# Appraisify module — context for Claude

Auto-loaded when Claude touches anything under `modules/appraisify/`. See the
repo-wide `/CLAUDE.md` for the layered-architecture rule and shared helpers.

## What it is

A three-phase performance-appraisal cycle. Each `Appraisal` links **three
Users** — reviewee, reviewer, partner — and moves through:

```
INITIALIZED → REVIEWER_PENDING → PARTNER_PENDING → SUBMITTED
```

- **Reviewee** fills the self-assessment while stage = `INITIALIZED`.
- **Reviewer** scores while stage = `REVIEWER_PENDING` (sees the self-assessment
  read-only).
- **Partner** adds final scores while stage = `PARTNER_PENDING` (sees self +
  reviewer read-only).

Each submission advances the stage by one and stamps `xSubmittedAt`.

## Domain (single sources of truth — don't open-code these)

`domain/models.ts` is pure (no `server-only`, no Prisma):

- `nextAppraisalStage(stage)` — the stage state machine.
- `phaseAccessFor(stage, phase)` → `"editable" | "not-ready" | "submitted"` —
  drives the amber "not ready" banner and the already-submitted → confirmation
  redirect. `isPhaseOpen` / `isPhaseSubmitted` wrap it.
- `resolvePhaseForUser(appraisal, userId)` — which role the viewer plays.
- `toAppraisalListItem(record, viewerId)` — record → viewer-scoped list row.
- `scoreSummary` / `averagePhaseScore` / `answeredCount` — pure score math.
- `DEFAULT_APPRAISAL_QUESTIONS` — the seeded question set snapshotted onto each
  appraisal at creation (v1 has no admin question-builder).
- `buildAppraisalReference(year, seq)` → `APR-2026-000042`.

View-model + page-data types (`AppraisalRecord`, `AppraisalListItem`,
`EmployeeAppraisalDashboardData`, `AdminAppraisalDashboardData`, `AppraisalFormData`,
…) also live here — import them from the domain, NOT from a route folder.

## Layers

- `infrastructure/appraisal.repository.ts` — the only place Prisma is touched.
  Single-object `appraisalRepository`. `mapAppraisal` / `mapQuestion` produce
  the domain view-models; scores are `Decimal(4,2)` → coerce with `decOrNull`
  (wraps `toNumber` from `lib/decimal.ts`). `writePhase({ submit })` advances the
  stage (via `nextAppraisalStage`) + stamps `xSubmittedAt` in one transaction,
  and writes each question's phase columns.
- `application/services/appraisal-page-data.service.ts` — `getXxxData()` bags
  for the pages (`getEmployeeAppraisalDashboardData`, `getAppraisalFormData`,
  `getAppraisalConfirmationData`, `getAdminAppraisalDashboardData`). Each does
  `getCurrentSession()` → `resolveActiveOrgId` → repo calls → view-models.
- `application/services/appraisal-workflow.service.ts` — Zod schemas
  (`submitPhaseSchema`, `createAppraisalsSchema`, exported for the actions) +
  `submitAppraisalPhase` / `createAppraisalsForEmployees`. Re-validates server-side
  and **enforces gating**: the caller must own the phase and the phase must be
  open; final submit requires every question scored.

## UI

Pages live in `app/(employee)/employee/appraisals/` and
`app/(admin)/admin/appraisals/`. Both trees have a nested `layout.tsx` that loads
Material Symbols + the scoped `appraisify.css` and wraps children in
`.appraisify-scope` (which remaps `--primary` to the Appraisify blue `#136dec`,
so the reference's `bg-primary` classes render correctly). Presentational helpers
(`Icon`, `Skel`, `PHASE_ACCENT`, `NotReadyBanner`, `stageBadge`) live in
`app/(employee)/employee/appraisals/_ui.tsx`; the confirmation screen in
`_confirmation.tsx`. One phase-aware `appraisal-form-client.tsx` renders all three
phases (accent by phase: reviewee=amber, reviewer=emerald, partner=purple).

## Gotchas

- The three people are **Users** (like `Claim` / `ApprovalRequest`), each a
  distinct `@relation` on `User`. Cascade-delete only on the reviewee.
- Scores are `Decimal(4, 2)` (1–5). Always `toNumber()` / `decOrNull` before math.
- Nav is **always-on** (no `EmployeePolicy` / org-plan gate) — v1 decision.
- Admin pages: the group layout already enforces `requirePortalSession("ADMIN")`
  (accepts OWNER), so pages only check `if (!session) redirect("/login")` — do
  NOT re-check `role === "ADMIN"` (that rejects owners).
- `npm run db:seed-appraisals` creates sample cycles + runs the create→submit
  round-trip assertions.

## Don't

- Don't open-code the stage machine or gating — use `nextAppraisalStage` /
  `phaseAccessFor`.
- Don't add `prisma.*` to a service — add a repo method.
- Don't put view-model / page-data types in a route folder — they belong in
  `domain/models.ts` so services and clients share one definition.
