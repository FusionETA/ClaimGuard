import { expect, it } from "vitest"

import { apiGet, describeSmoke } from "./helpers/client"

/**
 * Read-only smoke coverage for GET /api/v1/attendance/summary.
 *
 * Contract (app/api/v1/attendance/summary/route.ts):
 *   { data: EmployeeRow[], totals: Buckets, range: {from,to}, total }
 *
 * Everything is MINUTES. Requires `attendance:read`.
 */

const BUCKET_KEYS = [
  "normalMin",
  "otMin",
  "restDayMin",
  "publicHolidayMin",
  "totalMin",
  "otApprovedMin",
  "otPendingMin",
  "otRejectedMin",
] as const

type Buckets = Record<(typeof BUCKET_KEYS)[number], number> & {
  expectedMin: number
}

type SummaryBody = {
  data: Array<{
    employeeId: string
    name: string
    email: string
    otEnabled: boolean
    buckets: Buckets
  }>
  totals: Buckets
  range: { from: string; to: string }
  total: number
}

const FROM = "2026-08-01"
const TO = "2026-08-31"

describeSmoke("attendance summary API smoke (read-only)", () => {
  it("requires both from and to", async () => {
    expect((await apiGet("/api/v1/attendance/summary")).status).toBe(400)
    expect(
      (await apiGet(`/api/v1/attendance/summary?from=${FROM}`)).status,
    ).toBe(400)
  })

  it("rejects an inverted range", async () => {
    const res = await apiGet(
      `/api/v1/attendance/summary?from=${TO}&to=${FROM}`,
    )
    expect(res.status).toBe(400)
  })

  it("rejects a non-ISO date", async () => {
    const res = await apiGet(
      `/api/v1/attendance/summary?from=01-08-2026&to=${TO}`,
    )
    expect(res.status).toBe(400)
  })

  it("returns totals and per-employee buckets in minutes", async () => {
    const res = await apiGet<SummaryBody>(
      `/api/v1/attendance/summary?from=${FROM}&to=${TO}`,
    )

    expect(res.status, "needs `attendance:read` on the smoke token").toBe(200)
    expect(res.body.range).toEqual({ from: FROM, to: TO })
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.total).toBe(res.body.data.length)

    // Every bucket key present on totals, even with no data at all —
    // a missing key would read as "unknown" rather than "zero".
    for (const key of BUCKET_KEYS) {
      expect(typeof res.body.totals[key], `totals.${key}`).toBe("number")
      expect(res.body.totals[key]).toBeGreaterThanOrEqual(0)
    }
    expect(typeof res.body.totals.expectedMin).toBe("number")

    for (const row of res.body.data) {
      expect(typeof row.employeeId).toBe("string")
      expect(typeof row.name).toBe("string")
      // Drives whether a caller renders OT as "n/a" rather than "0".
      expect(typeof row.otEnabled).toBe("boolean")
      for (const key of BUCKET_KEYS) {
        expect(typeof row.buckets[key], `${row.name}.${key}`).toBe("number")
      }
      expect(typeof row.buckets.expectedMin).toBe("number")
    }
  })
})
