# app/api/v1/ — the partner REST API

Versioned, token-authenticated REST surface. This is the contract
external integrators (Altomate Accounting, ABPay, the AltomateHR MCP
server) build against — every path here is public API, so moving one is
a breaking change unless an alias stays behind.

## The credential rule

**The path prefix tells you which credential the route requires.** Three
auth modes exist and they are not interchangeable:

| Prefix | Credential | Wrapper | Meaning |
|---|---|---|---|
| `/api/v1/admin/*` | master key `wp_master_*` | `handleMasterApiRequest` (`lib/master-api-auth.ts`) | Platform provisioning. Creates tenants; **cannot read tenant data**. |
| `/api/v1/auth/*` | either, by prefix | `handleAuthEndpointRequest` (`./auth/_shared.ts`) | Identity/authentication only. Deliberately dual-mode — a master key authenticates an owner across every org they administer. |
| everything else | per-org token `wp_live_*` | `handleApiRequest` (`lib/api-auth.ts`) | Normal tenant work. The token's `organizationId` is the whole org scope; a token can never reach another org's rows. |

A leaked master key must only be able to create new tenants, never read
existing ones. That property is what the prefix split protects, so:

- **Don't add a per-org route under `admin/`.** If it takes `wp_live_*`,
  it belongs at the top level as its own resource.
- **Don't add a master-key route outside `admin/`.**
- `auth/*` is the one deliberate exception and it stays closed — its
  handlers grant identity, never data.

### Aliases

`admin/admins`, `admin/admins/[email]` and `admin/sso-ticket` are
per-org routes that used to live under `admin/`. They are now thin
`export { … } from` aliases pointing at the canonical top-level paths:

| Alias (deprecated) | Canonical |
|---|---|
| `POST /api/v1/admin/admins` | `POST /api/v1/admins` |
| `PATCH`/`DELETE /api/v1/admin/admins/[email]` | `…/api/v1/admins/[email]` |
| `POST /api/v1/admin/sso-ticket` | `POST /api/v1/sso-ticket` |

Alias files contain no logic and gain no new methods. Remove them once
the known callers (Altomate Accounting, the MCP server) have moved.

## Route conventions

1. Every handler goes through one of the three wrappers above. They
   supply auth, the audit-log write, `Cache-Control: private, no-store`
   and `X-API-Version: v1`. Never hand-roll a bearer check.
2. Scopes come from `lib/api-scopes.ts`. `:read` covers GET, `:write`
   covers POST/PATCH/DELETE. Pass `[]` only when a route needs a valid
   token but no particular grant (`whoami`, `sso-ticket`, admin
   management).
3. Routes call **services or repositories**, never Prisma directly —
   same rule as the rest of `app/` (see `app/CLAUDE.md`).
4. Validate every body with Zod and return
   `{ error: { status, message, details? } }` on failure. `POST /claims`
   is the one legacy exception returning a flat `{ error: string }`;
   don't copy it.
5. Cross-tenant probing returns **404, not 403** — a row that exists in
   another org must be indistinguishable from one that doesn't exist.

## Capability advertising

`GET /whoami` returns a `features` array from `lib/api-features.ts`
alongside `scopes`. Partners gate optional request blocks on it because
every PATCH schema here is `.strict()` — an unknown key 400s the whole
call, so a partner can't probe by just sending a new field, and without
the flag list adding one means coordinating deploy dates by hand.

**When you add an optional block to a PATCH schema, add its flag in the
same commit.** Flag names are permanent once shipped — partner code
branches on them. Never remove a flag for a capability that still works.

## Response envelopes

Four shapes are in use. Pick the one that matches the neighbours rather
than inventing a fifth:

- `{ data, pagination: { total, limit, offset, hasMore } }` — paged
  lists (employees, claims, payroll-runs).
- `{ data, total }` — unpaged lists (policies, projects, teams, admins).
- `{ data }` — a single resource.
- un-wrapped — `sso-ticket` and the `admin/*` provisioning routes.

## Testing

`tests/smoke/*.smoke.test.ts` drives a **deployed** environment over
HTTP with a scoped `wp_live_smoke_*` token (`npm run smoke`; skips when
`SMOKE_BASE_URL` / `SMOKE_API_TOKEN` are unset). A new resource here
should get a smoke suite alongside its siblings. These tests are pure
HTTP clients — no Prisma, no `server-only` imports.
