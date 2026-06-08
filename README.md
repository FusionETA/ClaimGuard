# AltomateHR

A Malaysian payroll & HR platform built as a dual-portal PWA. Admins
run payroll, manage employees and policies, sync to Xero, and file LHDN
forms. Employees clock in, submit claims, apply for leave, and view
their payslips — all from a mobile-first installable web app.

Built for Malaysian SMEs: LHDN PCB (Potongan Cukai Bulanan), EPF (KWSP
Third Schedule, all four parts), SOCSO (Act 4), EIS (Act 800), HRDF
(PSMB Act) — all computed from gazetted tables, not approximations.

---

## What's in the box

| Domain | Highlights |
|---|---|
| **Payroll** | Monthly runs with PCB/EPF/SOCSO/EIS/HRDF, per-employee profile, fixed + per-run adjustments, AR (additional remuneration) routing, salary-change proration, unpaid-leave docking, hourly + monthly rules, payslip PDF, LHDN-style PCB breakdown PDF |
| **LHDN forms** | CP22 (new hire), CP22A (cessation), CP21 (leaving Malaysia), TP3 (handover), PCB 2(II), Form E + CP8D + EA, PB ECP file for bulk PCB submission |
| **Xero sync** | Multi-domain OAuth (redirect URI per request host), per-run Manual Journal + Spend Money entries, claim sync as Bills, supporting docs as Related Files, idempotent retries, stuck-ERROR row recovery |
| **Claims** | Wizard with payment-source picker, OCR receipt scan via Gemini multimodal (images + PDF), per-account spend limits + period scopes, mileage claims with snapshot rate, supervisor + admin approval chain |
| **Leave** | 3-layer accrual (type → policy → employee), PRO_RATED with join-date backfill, expired carry-forward cash-out at payroll, org-wide + team-scoped balance views, bulk-import wizard |
| **Attendance** | Clock-in/out with geofencing, break sessions with edit log, OT auto-detection above policy threshold, multi-step approval chain, supervisor session edits propagated through approvers |
| **Realtime** | SSE over Redis pub/sub — supervisor queues + notification bell update live on claims/attendance review |
| **Auth** | Iron-session HMAC, four roles (OWNER/ADMIN/SUPERVISOR/EMPLOYEE), forgot-password via WhatsApp (Wazzup24), change-password from avatar area, SSO hand-off from Altomate Accounting |
| **Notifications** | Persisted in-app notification center with header bell on both surfaces, web push (PWA), daily digest cron for OT and pending approvals |
| **Audit log** | Per-org activity log (`/admin/audit`) — 4 tiers of instrumentation cover API tokens, Xero connect/disconnect, settings, COA, policies, teams, projects, payroll settings, employee archive |
| **External API v1** | Token-scoped REST API for partner integrations — employees, claims, payroll runs, projects, teams, policies. Internal `/internal/api-scopes` page (password-gated) for cross-org scope editing |
| **PWA** | Installable on iOS/Android, branded splash screens for every iPhone/iPad size, "What's new" sheet with curated changelog (`lib/updates.ts`) |

---

## Tech stack

| Layer | Tech |
|---|---|
| Framework | Next.js 16 (App Router, Server Actions, Server Components, Turbopack) |
| Runtime | React 19 |
| Language | TypeScript |
| Database | MariaDB / MySQL via Prisma 7 with `@prisma/adapter-mariadb` |
| Cache + pub/sub | Redis (ioredis), pass-through when `REDIS_URL` unset |
| Styling | Tailwind CSS |
| UI primitives | shadcn/ui (built on Radix UI) |
| Icons | Lucide React |
| Validation | Zod 4 |
| Auth | Hand-rolled HMAC-signed iron-session cookie |
| Web push | `web-push` (VAPID) |
| Xero | Hand-rolled OAuth + REST client (no SDK) |
| PDFs | `@react-pdf/renderer` for payslips, LHDN forms, manual journals |
| AI | Gemini multimodal (OCR + CSV mapping), Groq fallback for CSV |
| WhatsApp | Wazzup24 HTTP API |
| Email | Brevo HTTP API |
| Error monitoring | Sentry |
| Tests | Vitest |
| CI | GitHub Actions (lint + typecheck + tests + post-push smoke suite) |
| Deploy | DigitalOcean droplet + pm2 + nginx (HTML fallback for upstream-down windows) |

---

## Folder structure

```
.
├── app/                          # Next.js App Router pages + API routes
│   ├── (admin)/admin/            # Admin portal (OWNER + ADMIN)
│   │   ├── attendance/           # Attendance review + reports
│   │   ├── audit/                # Per-org activity log
│   │   ├── claims/               # Claims queue + review
│   │   ├── company-structure/    # Teams + project managers
│   │   ├── hierarchy/            # Employees, supervisors, bulk import
│   │   ├── leave/                # Approvals, balances, applications
│   │   ├── payroll/              # Runs, profiles, settings, LHDN forms
│   │   └── settings/             # Org, accounts, Xero, projects, attendance, leave
│   ├── (employee)/employee/      # Employee + supervisor portal
│   │   ├── account/              # Profile + change password
│   │   ├── attendance/           # Clock in/out, history, team, approvals
│   │   ├── claims/               # New claim + history
│   │   ├── leave/                # Apply + history + team (supervisor)
│   │   ├── payslip/              # Latest payslip
│   │   ├── payslips/             # Full payslip history
│   │   └── review/               # Pending claim approvals (supervisor)
│   ├── api/                      # REST endpoints
│   │   ├── admin/                # Internal admin endpoints
│   │   ├── attendance/           # Clock in/out, geofence, break
│   │   ├── claims/               # OCR, file uploads
│   │   ├── cron/                 # Scheduled jobs (CRON_SECRET-gated)
│   │   ├── employee/             # Employee context polling
│   │   ├── health/               # Layer 3 health endpoint for smoke
│   │   ├── leave/                # Balance + apply context
│   │   ├── notifications/        # Notification CRUD + bell counts
│   │   ├── ocr/                  # Gemini receipt OCR
│   │   ├── push/                 # Web push subscribe/unsubscribe
│   │   ├── realtime/             # SSE stream
│   │   ├── sso/altomate/         # SSO hand-off from Altomate Accounting
│   │   ├── v1/                   # Public REST API for partners
│   │   └── xero/                 # OAuth, file proxy
│   ├── forgot-password/          # WhatsApp-code reset flow
│   ├── internal/                 # Internal tools (password-gated)
│   ├── login/                    # Login page + action
│   ├── layout.tsx                # Root layout (UpdatesAnnouncer mounted here)
│   └── page.tsx                  # Root redirect by role
│
├── components/                   # Reusable React components
│   ├── admin/                    # Admin-portal feature components
│   ├── attendance/               # Employee/supervisor attendance UI
│   ├── claims/                   # Shared claim UI (status badge, charts, etc.)
│   ├── layout/                   # Admin + employee shells (sidebar, nav)
│   ├── pwa/                      # Service worker, push prompt, resume indicator
│   ├── ui/                       # Canonical design-system primitives
│   └── updates-announcer.tsx     # Top banner + slide-in changelog sheet
│
├── lib/                          # Shared client+server utilities
│   ├── auth/                     # Session, password, role helpers
│   ├── ai/                       # Gemini + Groq providers (OCR + CSV mapping)
│   ├── cache.ts, redis.ts        # Read-through Redis cache (server-only)
│   ├── decimal.ts                # toNumber() for Prisma Decimal coercion
│   ├── form-state.ts             # FormState<V, E> for server actions
│   ├── geo.ts                    # Geofence + distance helpers
│   ├── mileage.ts                # Mileage rate + amount (pure)
│   ├── prisma.ts                 # Prisma singleton (returns null if DB env missing)
│   ├── push-notifications.ts     # Web push helpers
│   ├── updates.ts                # Curated changelog (banner + sheet content)
│   ├── utils.ts                  # cn, formatCurrency, formatShortDate, buildInitials
│   ├── web-push.ts               # VAPID key loader + sendPushToUser
│   ├── whatsapp.ts               # Wazzup24 client + phone normalization
│   └── xero.ts                   # OAuth, token refresh, bills, spend money, files
│
├── modules/                      # DDD-lite domain modules
│   ├── attendance/               # Clock, geofence, OT auto-detection, approval chain
│   ├── audit/                    # Per-org activity log
│   ├── claims/                   # Claim lifecycle, mileage, spend limits, OCR
│   ├── leave/                    # Accrual, balances, applications, carry-forward
│   ├── notifications/            # In-app center, push subscriptions
│   ├── organization/             # Org, Xero connection, COA, admins, master API
│   ├── payroll/                  # PCB, EPF, SOCSO, EIS, HRDF, runs, LHDN forms
│   └── policy/                   # Employee policies (payout method, salary type, etc.)
│
├── prisma/
│   ├── schema.prisma             # 46 models — see "Database" below
│   ├── seed.ts                   # Sample data (orgs, admins, claims)
│   ├── create-org-seed.ts        # Reusable script: seed new org + OWNER
│   ├── create-master-key.ts      # Mint a master API key for partner integrations
│   └── backfill-*.ts             # One-off migration helpers
│
├── tests/smoke/                  # Post-push API smoke suite (Tier 1)
│   ├── *.smoke.test.ts           # 9 suites (claims, employees, COA, policies, projects, teams, settings, payroll-readonly, cleanup)
│   └── helpers/client.ts         # Shared HTTP client
│
├── docs/                         # DESIGN, XERO, deployment notes
│
├── generated/prisma/             # Auto-generated client (do not edit)
│
├── .github/workflows/            # CI + post-push smoke trigger
├── middleware.ts                 # Auth role gate + rolling-session renewal
├── vitest.config.ts              # Unit tests (modules/payroll/domain/__tests__)
├── vitest.smoke.config.ts        # Post-push API smoke runner
└── CLAUDE.md                     # Repo-wide context (each module has its own too)
```

---

## Architecture

**DDD-lite layered structure** inside `modules/<m>/`:

- **`domain/`** — pure TypeScript types and pure helpers. Unit-tested
  with vitest. No Prisma, no I/O. PCB / EPF / SOCSO math lives here.
- **`application/services/`** — orchestration. Validates with Zod,
  calls repositories + other services, never raw Prisma.
- **`infrastructure/`** — all `prisma.*` calls. One repo file per
  aggregate.

**Hard rules** (enforced by ESLint `no-restricted-imports`):

1. Pages and API routes call **services only**, never repositories
   or Prisma directly.
2. Services call **repositories only**, never Prisma directly.
3. Anything `import "server-only"` cannot land in `lib/` — `lib/` is
   the shared client+server zone.

**Server Actions** handle all form mutations (Zod-validated,
session-checked, `revalidatePath` after writes). API routes are used
only where a plain HTTP response is needed (push endpoints, Xero
OAuth callback, SSE stream, cron jobs, external partner API).

Per-module conventions live in `modules/<m>/CLAUDE.md`, `app/CLAUDE.md`,
`components/CLAUDE.md`, `lib/CLAUDE.md`, and `prisma/CLAUDE.md`. Read
those before touching a module.

---

## Database

46 Prisma models, grouped by domain:

| Domain | Models |
|---|---|
| **Identity** | `User`, `Organization`, `AdminOrganization`, `EmployeeProfile`, `EmployeeProjectAssignment` |
| **Access & integrations** | `ApiIntegration`, `ApiAuditLog`, `MasterApiKey`, `MasterApiAuditLog`, `XeroConnection`, `XeroProject` |
| **Claims** | `Claim`, `ClaimSupportingAttachment`, `ClaimApprovalEntry`, `ChartOfAccount` |
| **Attendance** | `AttendanceRecord`, `AttendanceEditLog`, `BreakSession`, `BreakSessionEditLog`, `ApprovalRequest`, `ApprovalChainStep` |
| **Teams & projects** | `Team`, `EmployeeTeamMembership`, `ProjectHoliday`, `ProjectManager` |
| **Payroll** | `PayrollProfile`, `SalaryChange`, `PayrollSettings`, `PayrollCompanyInfo`, `PayrollRun`, `PayrollRunReport`, `PayrollAnnualReport`, `PayrollRunClaim`, `PayrollRunAdjustment`, `Payslip`, `PayslipLineItem`, `EmployeeLoan` |
| **Leave** | `LeaveType`, `PolicyLeaveEntitlement`, `LeaveEntitlement`, `LeaveApplication`, `EmployeePolicy` |
| **Notifications & ops** | `PushSubscription`, `Notification`, `OrganizationAuditLog`, `EmployeeImportDraft` |

See `prisma/CLAUDE.md` for schema gotchas (which columns are loose
strings vs enums, which Decimals need `toNumber()`, etc.).

---

## Environment

Copy `.env.example` to `.env` and fill in. The example file documents
every variable, what's optional vs required, and how to generate
secrets. Highlights:

- `DATABASE_URL` + `DATABASE_*` — MariaDB connection (required)
- `AUTH_SECRET` — HMAC secret for iron-session (required in prod)
- `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` — Xero OAuth (optional)
- `GEMINI_API_KEY` — receipt OCR + CSV import (required for those flows)
- `GROQ_API_KEY` — CSV import fallback when Gemini errors
- `WAZZUP_API_KEY` / `WAZZUP_CHANNEL_ID` — forgot-password WhatsApp delivery
- `VAPID_*` — web push (optional)
- `REDIS_URL` — cache + SSE pub/sub (optional; pass-through when unset)
- `CRON_SECRET` — shared bearer for `/api/cron/*`
- `SENTRY_DSN` — error monitoring (optional)

---

## Local development

```bash
# Install
npm install

# Set up env
cp .env.example .env
# (edit .env to point at your local MariaDB + fill in optional keys)

# Database
npm run db:generate     # generate Prisma client
npm run db:push         # push schema (no migration file — dev mode)
npm run db:seed         # seed sample org + admins

# Dev server (Turbopack)
npm run dev
```

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Next dev server with Turbopack |
| `npm run build` | Production build |
| `npm test` | Vitest unit tests (payroll domain + attendance + statutory tables) |
| `npm run smoke` | Post-push API smoke suite against a live deploy |
| `npm run db:studio` | Open Prisma Studio for DB inspection |
| `npm run db:create-master-key` | Mint a master API key for a partner |

Every meaningful change should pass:

```bash
npx tsc --noEmit --incremental false   # type check
npm test                                # unit tests
npm run build                           # full Next.js build
```

---

## Testing

**Unit tests** (`modules/payroll/domain/__tests__/`,
`modules/attendance/domain/__tests__/`) — pure-function tests for
statutory math (PCB tables, EPF KWSP Third Schedule, SOCSO/EIS step
tables) and the orchestrator. Run with `npm test`. **Keep them green.**
They cover edge cases real users hit every cycle.

**Smoke suite** (`tests/smoke/`) — 9 API integration suites that run
against a live deploy after each push to `main`. Triggered by GitHub
Actions (`.github/workflows/smoke.yml`) using a smoke-org API token.
Covers claims, employees, COA, policies, projects, teams, settings,
payroll (read-only), with a final cleanup sweep.

There is no Playwright / browser test suite yet — manual click-through
plus the API smoke suite are the production verification loop.

---

## Deployment

Two environments running on a single DigitalOcean droplet:

- **dev** — `altomatehr-dev.fusioneta.com.my` (Zi-Rong branch + main)
- **prod** — `altomatehr.fusioneta.com.my` (main only, after smoke passes)

Both run under `pm2` (`altomatehr-dev`, `altomatehr-prod`) behind
nginx. Deploys are pushed via a GitHub webhook → custom Node receiver
at `127.0.0.1:9000` → shell script that pulls, builds, restarts.

Planned-outage UX is handled at the nginx layer: when the upstream is
unreachable (deploy restart, `pm2 stop`, OOM), nginx serves a static
fallback HTML page. The in-app `MAINTENANCE_MODE` gate was removed in
favour of this — one mechanism, all outage cases.

User-facing heads-up before scheduled maintenance lives in
`<UpdatesAnnouncer>` (top banner + slide-in sheet, content edited in
`lib/updates.ts`).

---

## Notable design decisions

- **No browser storage.** `localStorage` / `sessionStorage` are not
  used for anything that needs to persist. The admin's "active
  organisation" lives in the session cookie
  (`session.activeOrganizationId`), not local storage.
- **Decimals are sacred.** All money is `Decimal(12, 2)`; mileage rates
  are `Decimal(10, 4)`. Always coerce via `toNumber()` from
  `lib/decimal.ts` — never `Number(decimal)` (loses precision above
  2^53).
- **Statutory rates are gazetted, not configured.** EPF / SOCSO / EIS
  rates live in `modules/payroll/domain/statutory-tables.ts` with
  source citations, not in the database. Bumping a rate is a code
  change.
- **Payslip snapshots are immutable.** Each payslip stores the rates
  and computation that applied at the time. Changing org settings
  afterwards does NOT mutate historical payslips.
- **Xero sync is idempotent on the run/claim ID.** A partial failure
  doesn't double-create; retry skips entries that already landed.
- **AR vs recurring is per-line, not per-category.** The `treatAsRecurring`
  flag on each adjustment overrides the default LHDN AR treatment for
  that line — lets monthly-paid commission/director-fee smooth through
  the normal PCB formula instead of the AR spike.
