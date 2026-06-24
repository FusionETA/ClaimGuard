import { afterAll, beforeAll, expect, it } from "vitest"

import {
  apiDelete,
  apiGet,
  apiPost,
  describeSmoke,
  tag,
} from "./helpers/client"

/**
 * Smoke coverage for the employees API.
 *
 * Granted scopes: employees:read, employees:write, policies:read.
 * Drives the live /api/v1/employees CRUD surface over HTTP, using a
 * policy fetched from /api/v1/policies as the (required) policyId.
 */

type PolicyListBody = {
  data: Array<{ id: string; name: string | null }>
  total: number
}

type EmployeeShape = {
  id: string
  employeeProfileId: string | null
  name: string
  email: string
  role: "EMPLOYEE" | "SUPERVISOR"
  employeeId: string
  jobTitle: string
  payoutMethod: string
  otPayoutMethod: string
  policy: { id: string; name: string | null } | null
  projects: Array<{ id: string; name: string }>
  teams: Array<{
    teamId: string
    teamName: string
    projectId: string
    projectName: string
    layer: number
  }>
}

type EmployeeBody = { data: EmployeeShape }

type EmployeeListBody = {
  data: EmployeeShape[]
  pagination: {
    total: number
    limit: number
    offset: number
    hasMore: boolean
  }
}

type ActiveCountBody = { data: { count: number; asOf: string } }

type DeleteBody = { ok: true }

type ErrorBody = { error: { status: number; message: string } }

describeSmoke("employees API smoke", () => {
  // Safety-net cleanup: if the main test fails after create but before
  // its own DELETE, afterAll still removes the fixture.
  let employeeId: string | null = null
  let policyId: string | null = null

  beforeAll(async () => {
    const policies = await apiGet<PolicyListBody>("/api/v1/policies?limit=1")
    expect(policies.status).toBe(200)
    expect(Array.isArray(policies.body.data)).toBe(true)
    policyId = policies.body.data[0]?.id ?? null
    expect(policyId).toBeTruthy()
  })

  afterAll(async () => {
    if (employeeId) {
      await apiDelete(`/api/v1/employees/${employeeId}`)
      employeeId = null
    }
  })

  it("creates, reads, and deletes an employee", async () => {
    expect(policyId).toBeTruthy()
    const resolvedPolicyId = policyId as string

    // Unique-per-run identifiers to avoid email/employeeId collisions.
    const suffix = crypto.randomUUID().slice(0, 8)
    const name = tag("Employee")
    const email = `smoke+${suffix}@example.com`
    const externalEmployeeId = `SMOKE-${suffix}`

    // The v1 create-employee schema (since the "accepts full payroll
    // fields" change) requires gender / DOB / IC / marital status / tax
    // ref / join date alongside the account basics, and runs a superRefine
    // that demands an EPF number when contributeToEpf is true. We send
    // contributeToEpf: false here so the smoke fixture stays minimal —
    // no need to invent statutory IDs for a row we're about to delete.
    // Both salary figures are sent so this test works against either a
    // MONTHLY- or HOURLY-typed policy (the API only enforces the one
    // that matches the resolved policy's salaryType).
    const created = await apiPost<EmployeeBody>("/api/v1/employees", {
      name,
      email,
      password: "Smoke-Test-1234",
      employeeId: externalEmployeeId,
      role: "EMPLOYEE",
      jobTitle: "Smoke Tester",
      policyId: resolvedPolicyId,
      phone: "+60123456789",
      gender: "MALE",
      dateOfBirth: "1990-01-01",
      idNumber: `SMOKE-IC-${suffix}`,
      maritalStatus: "SINGLE",
      incomeTaxNumber: `SG-SMOKE-${suffix}`,
      joinDate: "2024-01-01",
      contributeToEpf: false,
      monthlySalary: 5000,
      hourlyRate: 25,
    })

    expect(created.status).toBe(201)
    expect(created.body.data).toBeTruthy()
    expect(typeof created.body.data.id).toBe("string")
    expect(created.raw.headers.get("location")).toBe(
      `/api/v1/employees/${created.body.data.id}`,
    )

    employeeId = created.body.data.id

    // GET the single resource and assert the projected shape.
    const fetched = await apiGet<EmployeeBody>(
      `/api/v1/employees/${employeeId}`,
    )
    expect(fetched.status).toBe(200)
    const emp = fetched.body.data
    expect(emp.id).toBe(employeeId)
    expect(emp.email).toBe(email.toLowerCase())
    expect(emp.role).toBe("EMPLOYEE")
    expect(emp.employeeId).toBe(externalEmployeeId)
    expect("employeeProfileId" in emp).toBe(true)
    expect(emp.policy).not.toBeNull()
    expect(emp.policy?.id).toBe(resolvedPolicyId)

    // DELETE it.
    const deleted = await apiDelete<DeleteBody>(
      `/api/v1/employees/${employeeId}`,
    )
    expect(deleted.status).toBe(200)
    expect(deleted.body.ok).toBe(true)

    // GET again -> 404 with error envelope.
    const gone = await apiGet<ErrorBody>(`/api/v1/employees/${employeeId}`)
    expect(gone.status).toBe(404)
    expect(gone.body.error.status).toBe(404)

    // Successfully deleted — clear so afterAll doesn't double-delete.
    employeeId = null
  })

  it("lists employees and reports an active count with the expected envelopes", async () => {
    const list = await apiGet<EmployeeListBody>("/api/v1/employees?limit=5")
    expect(list.status).toBe(200)
    expect(Array.isArray(list.body.data)).toBe(true)
    expect(typeof list.body.pagination.total).toBe("number")
    expect(typeof list.body.pagination.limit).toBe("number")
    expect(typeof list.body.pagination.offset).toBe("number")
    expect(typeof list.body.pagination.hasMore).toBe("boolean")

    const activeCount = await apiGet<ActiveCountBody>(
      "/api/v1/employees/active-count",
    )
    expect(activeCount.status).toBe(200)
    expect(typeof activeCount.body.data.count).toBe("number")
    expect(typeof activeCount.body.data.asOf).toBe("string")
  })
})
