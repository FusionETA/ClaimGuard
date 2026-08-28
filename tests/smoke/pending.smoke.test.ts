import { expect, it } from "vitest"

import { apiGet, describeSmoke } from "./helpers/client"

/**
 * Read-only smoke coverage for GET /api/v1/pending.
 *
 * Contract (app/api/v1/pending/route.ts):
 *   { data: { claims?, leave?, attendance?, payrollRuns? },
 *     total: number,
 *     omitted?: string[] }
 *
 * The endpoint declares NO required scope and gates each section on the
 * token's own scopes instead, so the shape depends on what the smoke
 * token holds. The invariant we assert is the one that must hold for
 * every token: a section is either present in `data` or named in
 * `omitted`, never both and never neither.
 */

const SECTIONS = ["claims", "leave", "attendance", "payrollRuns"] as const
type Section = (typeof SECTIONS)[number]

type PendingBody = {
  data: Record<string, unknown>
  total: number
  omitted?: string[]
}

type PendingRun = {
  id: string
  periodYear: number
  periodMonth: number
  status: string
  payslipCount: number
}

describeSmoke("pending inbox API smoke (read-only)", () => {
  it("returns the envelope with a numeric total", async () => {
    const res = await apiGet<PendingBody>("/api/v1/pending")

    expect(res.status).toBe(200)
    expect(res.body).toBeTruthy()
    expect(typeof res.body.data).toBe("object")
    expect(typeof res.body.total).toBe("number")
    expect(res.body.total).toBeGreaterThanOrEqual(0)
  })

  it("accounts for every section exactly once — present or omitted", async () => {
    const res = await apiGet<PendingBody>("/api/v1/pending")
    expect(res.status).toBe(200)

    const present = new Set(Object.keys(res.body.data))
    const omitted = new Set(res.body.omitted ?? [])

    // No unknown keys leaked into either list.
    for (const key of present) {
      expect(SECTIONS).toContain(key as Section)
    }
    for (const key of omitted) {
      expect(SECTIONS).toContain(key as Section)
    }

    // The invariant: a section is visible or it is omitted. Never both,
    // never neither — otherwise a caller cannot tell "nothing pending"
    // from "you can't see this", which is the whole point of `omitted`.
    for (const section of SECTIONS) {
      const inData = present.has(section)
      const inOmitted = omitted.has(section)
      expect(
        inData !== inOmitted,
        `section "${section}" must be in exactly one of data/omitted`,
      ).toBe(true)
    }
  })

  it("reports pending counts as non-negative numbers", async () => {
    const res = await apiGet<PendingBody>("/api/v1/pending")
    expect(res.status).toBe(200)

    for (const key of ["claims", "leave", "attendance"] as const) {
      const section = res.body.data[key] as { pending: number } | undefined
      if (!section) continue // omitted for scope reasons — covered above.
      expect(typeof section.pending).toBe("number")
      expect(section.pending).toBeGreaterThanOrEqual(0)
    }
  })

  it("returns payroll runs inline, and only ones awaiting approval", async () => {
    const res = await apiGet<PendingBody>("/api/v1/pending")
    expect(res.status).toBe(200)

    const runs = res.body.data.payrollRuns as
      | { pendingApproval: number; runs: PendingRun[] }
      | undefined
    if (!runs) return // omitted for scope reasons.

    expect(typeof runs.pendingApproval).toBe("number")
    expect(Array.isArray(runs.runs)).toBe(true)
    expect(runs.runs.length).toBe(runs.pendingApproval)

    for (const run of runs.runs) {
      expect(typeof run.id).toBe("string")
      expect(typeof run.periodYear).toBe("number")
      expect(run.periodMonth).toBeGreaterThanOrEqual(1)
      expect(run.periodMonth).toBeLessThanOrEqual(12)
      expect(typeof run.payslipCount).toBe("number")
      // The section exists to answer "what is waiting on me" — anything
      // in another state being listed here would be a lie.
      expect(run.status).toBe("PENDING_APPROVAL")
    }
  })
})
