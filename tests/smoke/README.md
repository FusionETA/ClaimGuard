# API smoke tests (Tier 1 of the post-push test bot)

These tests drive the **live deployed** `/api/v1/*` API over HTTP to confirm
every module still works after a deploy. They are intentionally **not** part of
the unit lane (`npm test`) — they need a running environment and a token.

- **Runner:** `npm run smoke` → `vitest run --config vitest.smoke.config.ts`
- **Scope glob:** `tests/smoke/**/*.smoke.test.ts`
- **No Prisma, no `@/` imports** — pure HTTP via `helpers/client.ts`. The suite
  must never touch the database directly.
- **Target:** a dedicated `Smoke Test Co` org (dev DB) / `Smoke Test Co (prod)`
  org (prod DB). Creates/deletes are scoped to that org by the token, so real
  client data is never touched.

## Running locally

```bash
export SMOKE_BASE_URL="https://altomatehr-dev.fusioneta.com.my"
export SMOKE_API_TOKEN="wp_live_smoke_…"   # Smoke Test Co (dev) token
npm run smoke
```

If either env var is unset the suites **skip** (not fail), so a bare
`npm run smoke` is a harmless no-op.

## What each file covers

| File | Mode | Notes |
|---|---|---|
| `employees.smoke.test.ts` | create → read → delete | needs `policies:read` to pick a policy |
| `projects.smoke.test.ts` | create → read → delete | manual project |
| `teams.smoke.test.ts` | create → read → delete | creates + tears down a parent project |
| `claims.smoke.test.ts` | read-only | no DELETE endpoint; approval needs `approvals:write` (not granted) |
| `chart-of-accounts.smoke.test.ts` | read-only | token has `…:read` only |
| `policies.smoke.test.ts` | read-only | token has `policies:read` only |
| `payroll-readonly.smoke.test.ts` | read-only | lists runs + active-count; never approves |
| `settings.smoke.test.ts` | read-only | token has `settings:read` only |
| `zz-cleanup-sweep.smoke.test.ts` | sweep | fails if any `[SMOKE]`-tagged employee/team/project is left behind |

Write-capable modules self-clean each fixture in the same test / `afterAll`.
The sweep is the safety net for crashed runs and only polices deletable
resources.

## The token

Issued from the internal scope-control page (`/internal/api-scopes`) for the
`Smoke Test Co` org. Granted scopes:

```
employees:read  employees:write
projects:read   projects:write
teams:read      teams:write
chart-of-accounts:read
policies:read
payroll:read
claims:read     claims:write
settings:read
```

Rotate every **90 days**; regenerate from `/internal/api-scopes` and update the
GitHub repo secrets `SMOKE_API_TOKEN_DEV` / `SMOKE_API_TOKEN_PROD` to match.

## How it runs after a deploy

The DigitalOcean droplet's deploy script (`altomatehr-dev-deploy.sh` /
`altomatehr-prod-deploy.sh`) calls GitHub's workflow-dispatch API after the
pm2 restart succeeds, triggering `.github/workflows/smoke.yml` with
`target: dev | prod`. The workflow pre-flights `GET /api/health` (which echoes
the deployed `GIT_SHA`) before running the suite. It can also be run by hand
from the **Actions** tab.

> `scripts/check-orphans.ts` is a **separate** operator tool (talks to Prisma
> directly) for deep FK-consistency audits — it is not part of this suite.
