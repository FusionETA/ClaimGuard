import { expect, it } from "vitest"

import { apiGet, describeSmoke } from "./helpers/client"

/**
 * Read-only smoke coverage for the leave reads:
 *   GET /api/v1/leave/applications
 *   GET /api/v1/employees/[id]/leave-balances
 *
 * Requires `leave:read` (and `employees:read` to resolve an employee).
 *
 * Note the two different identifiers: `/leave/applications?employeeId=`
 * takes the EmployeeProfile id, while `/employees/[id]/leave-balances`
 * takes the User id. That asymmetry is deliberate (each resource keeps
 * one id) and is exactly the kind of thing that silently returns an
 * empty list when confused — so the balances test resolves the id from
 * the employees resource rather than assuming.
 */

type LeaveApplication = {
  id: string
  employeeId: string
  employeeName: string
  leaveTypeCode: string
  paid: boolean
  totalDays: number
  status: string
}

type Balance = {
  leaveTypeCode: string
  leaveTypeName: string
  entitledDays: number
  accruedDays: number
  usedDays: number
  availableDays: number
  carriedDays: number
}

type EmployeeRow = { id: string; employeeProfileId: string | null }

async function firstEmployee(): Promise<EmployeeRow | null> {
  const res = await apiGet<{ data: EmployeeRow[] }>("/api/v1/employees?limit=1")
  if (res.status !== 200) return null
  return res.body.data[0] ?? null
}

describeSmoke("leave API smoke (read-only)", () => {
  it("lists applications with the documented shape", async () => {
    const res = await apiGet<{ data: LeaveApplication[]; total: number }>(
      "/api/v1/leave/applications?limit=10",
    )

    expect(res.status, "needs `leave:read` on the smoke token").toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.total).toBe(res.body.data.length)

    for (const app of res.body.data) {
      expect(typeof app.id).toBe("string")
      expect(typeof app.employeeName).toBe("string")
      expect(typeof app.leaveTypeCode).toBe("string")
      expect(typeof app.paid).toBe("boolean")
      expect(typeof app.totalDays).toBe("number")
      expect(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).toContain(
        app.status,
      )
    }
  })

  it("filters by status", async () => {
    const res = await apiGet<{ data: LeaveApplication[] }>(
      "/api/v1/leave/applications?status=PENDING",
    )
    expect(res.status).toBe(200)
    for (const app of res.body.data) {
      expect(app.status).toBe("PENDING")
    }
  })

  it("honours limit", async () => {
    const res = await apiGet<{ data: LeaveApplication[] }>(
      "/api/v1/leave/applications?limit=1",
    )
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeLessThanOrEqual(1)
  })

  it("rejects a malformed date and an out-of-range limit", async () => {
    expect(
      (await apiGet("/api/v1/leave/applications?from=2026-8-1")).status,
    ).toBe(400)
    expect(
      (await apiGet("/api/v1/leave/applications?limit=9999")).status,
    ).toBe(400)
  })

  it("returns balances for an employee, keyed by User id", async () => {
    const employee = await firstEmployee()
    if (!employee) return // empty org — nothing to assert against.

    const res = await apiGet<{ data: Balance[]; year: number; total: number }>(
      `/api/v1/employees/${employee.id}/leave-balances`,
    )

    expect(res.status, "needs `leave:read` on the smoke token").toBe(200)
    expect(typeof res.body.year).toBe("number")
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.total).toBe(res.body.data.length)

    for (const row of res.body.data) {
      expect(typeof row.leaveTypeCode).toBe("string")
      expect(typeof row.entitledDays).toBe("number")
      expect(typeof row.usedDays).toBe("number")
      // `availableDays` is the computed figure callers should quote —
      // it must always be present, not derived by the caller.
      expect(typeof row.availableDays).toBe("number")
      expect(typeof row.carriedDays).toBe("number")
    }
  })

  it("echoes the requested year and rejects a bad one", async () => {
    const employee = await firstEmployee()
    if (!employee) return

    const ok = await apiGet<{ year: number }>(
      `/api/v1/employees/${employee.id}/leave-balances?year=2026`,
    )
    expect(ok.status).toBe(200)
    expect(ok.body.year).toBe(2026)

    const bad = await apiGet(
      `/api/v1/employees/${employee.id}/leave-balances?year=1999`,
    )
    expect(bad.status).toBe(400)
  })

  it("404s an employee id from another org", async () => {
    const res = await apiGet(
      "/api/v1/employees/clnotarealemployeeid00000/leave-balances",
    )
    // 404, never 200-with-empty — an empty list must mean "no rows yet",
    // not "wrong id".
    expect(res.status).toBe(404)
  })
})
