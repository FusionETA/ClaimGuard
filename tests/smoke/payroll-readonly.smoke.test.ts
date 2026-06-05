import { expect, it } from "vitest"

import { apiGet, describeSmoke } from "./helpers/client"

/**
 * Payroll API smoke — READ-ONLY.
 *
 * Payroll runs are never created/approved by the smoke suite (the
 * approve endpoint would mutate real-looking financial state and the
 * token only holds `payroll:read`). We just confirm the read surface
 * the partner integration depends on still responds with the right
 * envelope shapes: run list, run detail, and the active-employee count.
 */

type PayrollRun = {
  id: string
  periodYear: number
  periodMonth: number
  status: string
  totals: { gross: number; net: number; employeeCount: number }
}
type RunList = {
  data: PayrollRun[]
  pagination: { total: number; limit: number; offset: number; hasMore: boolean }
}
type RunDetail = {
  data: { run: PayrollRun; payslips: unknown[] }
}
type ActiveCount = { data: { count: number; asOf: string } }

describeSmoke("payroll API smoke (read-only)", () => {
  it("lists payroll runs with the paginated envelope", async () => {
    const res = await apiGet<RunList>("/api/v1/payroll-runs")
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(typeof res.body.pagination.total).toBe("number")
    expect(typeof res.body.pagination.hasMore).toBe("boolean")

    for (const run of res.body.data) {
      expect(typeof run.id).toBe("string")
      expect(typeof run.status).toBe("string")
      expect(typeof run.periodYear).toBe("number")
      expect(typeof run.totals.gross).toBe("number")
    }
  })

  it("reads a single run with its payslips when one exists", async () => {
    const list = await apiGet<RunList>("/api/v1/payroll-runs?limit=1")
    expect(list.status).toBe(200)

    const first = list.body.data[0]
    if (!first) {
      // Smoke Test Co may legitimately have no payroll runs yet.
      expect(list.body.pagination.total).toBe(0)
      return
    }

    const detail = await apiGet<RunDetail>(`/api/v1/payroll-runs/${first.id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.run.id).toBe(first.id)
    expect(Array.isArray(detail.body.data.payslips)).toBe(true)
  })

  it("returns the active-employee headcount", async () => {
    const res = await apiGet<ActiveCount>("/api/v1/employees/active-count")
    expect(res.status).toBe(200)
    expect(typeof res.body.data.count).toBe("number")
    expect(res.body.data.count).toBeGreaterThanOrEqual(0)
    expect(typeof res.body.data.asOf).toBe("string")
  })
})
