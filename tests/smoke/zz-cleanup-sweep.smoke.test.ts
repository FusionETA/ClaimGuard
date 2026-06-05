import { expect, it } from "vitest"

import {
  apiDelete,
  apiGet,
  describeSmoke,
  isSmokeName,
  SMOKE_PREFIX,
} from "./helpers/client"

/**
 * Leftover-sweep — the final smoke test (filename `zz-` so it sorts last).
 *
 * Every write-capable suite self-cleans its own fixtures. This is the
 * safety net: it re-lists the DELETABLE resources and asserts NONE carry
 * the `[SMOKE]` prefix, catching any fixture a crashed/aborted run left
 * behind. Anything it does find, it best-effort deletes (so the next run
 * starts clean) AND fails the assertion (so the leak is visible).
 *
 * Why API-only and not `scripts/check-orphans.ts`? That script talks to
 * Prisma directly and the smoke suite must never touch the DB — it only
 * ever hits the live API. `check-orphans.ts` stays a separate operator
 * tool, run by hand on the droplet for deep FK-consistency audits.
 *
 * Scope note: only `employees`, `projects`, `teams` are deletable with
 * the smoke token, so only those are swept. Read-only modules (claims,
 * chart-of-accounts, policies, payroll, settings) create nothing, and
 * claims have no DELETE endpoint, so they are intentionally not swept.
 */

type Listed = { id: string; name?: string; title?: string; email?: string }
type ListEnvelope = { data: Listed[] }

const SWEEPABLE: Array<{ label: string; listPath: string; deletePath: (id: string) => string }> = [
  {
    label: "employees",
    listPath: "/api/v1/employees?limit=200",
    deletePath: (id) => `/api/v1/employees/${id}`,
  },
  {
    label: "teams",
    listPath: "/api/v1/teams",
    deletePath: (id) => `/api/v1/teams/${id}`,
  },
  {
    label: "projects",
    listPath: "/api/v1/projects?isManual=true",
    deletePath: (id) => `/api/v1/projects/${id}`,
  },
]

describeSmoke("smoke fixture leftover sweep", () => {
  it("leaves no [SMOKE]-tagged fixtures behind in deletable resources", async () => {
    const leaked: string[] = []

    for (const resource of SWEEPABLE) {
      const res = await apiGet<ListEnvelope>(resource.listPath)
      // A read failure here is itself a regression worth surfacing.
      expect(
        res.status,
        `expected 200 listing ${resource.label}, got ${res.status}`,
      ).toBe(200)

      const rows = Array.isArray(res.body?.data) ? res.body.data : []
      const ours = rows.filter(
        (r) =>
          isSmokeName(r.name) || isSmokeName(r.title) || isSmokeName(r.email),
      )

      for (const row of ours) {
        leaked.push(`${resource.label}:${row.id} (${row.name ?? row.title ?? row.email ?? "?"})`)
        // Best-effort cleanup so the next run starts from a clean slate,
        // even though we still fail below to make the leak visible.
        await apiDelete(resource.deletePath(row.id))
      }
    }

    expect(
      leaked,
      `Found ${leaked.length} leftover ${SMOKE_PREFIX} fixture(s) (now deleted): ${leaked.join(", ")}`,
    ).toEqual([])
  })
})
