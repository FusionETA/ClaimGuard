# AltomateHR

An employee expense claims management system with optional Xero integration. Admins manage the claims lifecycle and Xero connectivity; employees submit and track their own claims.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 15](https://nextjs.org/) — App Router, Server Actions, Server Components |
| Language | TypeScript |
| Database | MariaDB / MySQL via [Prisma ORM](https://www.prisma.io/) with `@prisma/adapter-mariadb` |
| Styling | [Tailwind CSS](https://tailwindcss.com/) |
| UI components | [Radix UI](https://www.radix-ui.com/) primitives + [shadcn/ui](https://ui.shadcn.com/) |
| Icons | [Lucide React](https://lucide.dev/) |
| Validation | [Zod](https://zod.dev/) |
| Auth | Custom session-based auth with `iron-session` |
| Push notifications | [Web Push](https://www.npmjs.com/package/web-push) (PWA) |
| Xero integration | Xero OAuth 2.0 — hand-rolled fetch client (no SDK) |
| Seed / scripts | [tsx](https://github.com/privatenumber/tsx) |

---

## Folder Structure

```
.
├── app/                          # Next.js App Router pages and API routes
│   ├── (admin)/                  # Route group — admin-only pages
│   │   └── admin/
│   │       ├── claims/           # Claims queue and review
│   │       ├── hierarchy/        # Employee and supervisor management
│   │       ├── settings/         # Org settings, Xero connection, COA, projects
│   │       ├── layout.tsx        # Admin shell layout
│   │       └── page.tsx          # Admin dashboard
│   ├── (employee)/               # Route group — employee-only pages
│   │   └── employee/
│   │       ├── claims/           # Claim history and new claim submission
│   │       ├── account/          # Employee profile
│   │       ├── review/           # Claim review status
│   │       └── layout.tsx        # Employee shell layout
│   ├── api/
│   │   ├── claims/               # REST endpoints for claim actions
│   │   ├── push/                 # Web push subscribe / unsubscribe
│   │   └── xero/
│   │       ├── connect/          # Initiates Xero OAuth flow
│   │       └── callback/         # Handles Xero OAuth callback + token exchange
│   ├── login/                    # Login page and auth action
│   ├── layout.tsx                # Root layout
│   └── page.tsx                  # Root redirect
│
├── components/                   # Reusable React components
│   ├── admin/                    # Admin-specific UI (claims table, settings panel, Xero card)
│   ├── claims/                   # Shared claims UI (queue, history, badges, charts)
│   ├── layout/                   # Shell wrappers (admin-shell, employee-shell)
│   ├── pwa/                      # Push notification prompt, service worker register
│   └── ui/                       # Base design system (button, card, input, toaster…)
│
├── lib/                          # Shared server utilities
│   ├── auth/                     # Session management, password hashing, auth types
│   ├── app-store.ts              # In-memory cache invalidation helpers
│   ├── database-config.ts        # DB connection config from env
│   ├── prisma.ts                 # Prisma client singleton
│   ├── push-notifications.ts     # Web push helpers
│   ├── utils.ts                  # General utilities (cn, etc.)
│   ├── web-push.ts               # VAPID key loader
│   └── xero.ts                   # Xero API client (OAuth, token refresh, accounts, projects, bills)
│
├── modules/                      # Domain modules (DDD-lite layered architecture)
│   ├── claims/
│   │   ├── application/services/ # Admin portal, employee portal, claim workflow, analytics
│   │   ├── domain/models.ts      # Claim domain types
│   │   └── infrastructure/       # claim.repository.ts — all DB queries for claims
│   └── organization/
│       ├── application/services/ # Xero connection service, org-admin service
│       ├── domain/models.ts      # Org and Xero domain types
│       └── infrastructure/       # organization.repository.ts — org, COA, projects, Xero connection
│
├── prisma/
│   ├── schema.prisma             # Database schema
│   ├── seed.ts                   # Seed script (admin accounts, orgs, sample data)
│   └── backfill-organization.ts  # One-off migration helper
│
├── docs/
│   ├── DESIGN.md                 # UI/UX design decisions
│   └── XERO.md                   # Xero integration setup guide
│
├── generated/
│   └── prisma/                   # Auto-generated Prisma client (do not edit)
│
└── middleware.ts                 # Route protection (session check, role-based redirects)
```

---

## Database Models

| Model | Purpose |
|---|---|
| `User` | All users — role is `ADMIN`, `SUPERVISOR`, or `EMPLOYEE` |
| `Organization` | A company using AltomateHR |
| `EmployeeProfile` | Extended profile for non-admin users (employee ID, job title, supervisor) |
| `Claim` | An expense claim submitted by an employee |
| `ChartOfAccount` | Xero accounts imported per organisation — employees select one per claim |
| `XeroConnection` | OAuth token set for one Xero tenant, scoped to an organisation |
| `XeroProject` | Xero projects imported per organisation |
| `PushSubscription` | Web push subscription per user |

---

## Architecture Notes

The app follows a **DDD-lite layered structure** inside `modules/`:

- **Domain** — pure TypeScript types, no external dependencies
- **Application / Services** — orchestration logic, calls repositories and external APIs
- **Infrastructure / Repositories** — all Prisma DB access isolated here

Pages and API routes call service functions only — never Prisma directly. This keeps DB queries in one place and makes the service layer independently testable.

**Server Actions** are used for all form mutations (Zod-validated, session-checked). API routes are used only where a plain HTTP response is needed (redirects, push endpoints, Xero OAuth callback).

---

## Environment Variables

```env
# Database
DATABASE_HOST=
DATABASE_PORT=3306
DATABASE_USER=
DATABASE_PASSWORD=
DATABASE_NAME=

# Session
SESSION_SECRET=                  # min 32 chars

# Xero OAuth (optional — app works without Xero)
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_REDIRECT_URI=               # e.g. https://yourdomain.com/api/xero/callback
XERO_SCOPES=offline_access accounting.transactions accounting.contacts projects
XERO_DEFAULT_ACCOUNT_CODE=       # fallback account code for bill creation

# Web Push (optional)
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=                   # e.g. mailto:admin@example.com
```

---

## Getting Started

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env

# Push schema to database
npx prisma db push

# Seed initial data
npx tsx prisma/seed.ts

# Run development server
npm run dev
```
