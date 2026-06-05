import { expect, it } from "vitest"

import { apiGet, describeSmoke } from "./helpers/client"

/**
 * READ-ONLY smoke coverage for the policies API.
 *
 * The token for this suite carries only `policies:read`, so there are no
 * creates, deletes, or set-default calls here — just GET list + GET [id]
 * against whatever policies already exist in the Smoke Test Co org.
 *
 * Contract (from app/api/v1/policies/route.ts):
 *   - GET /api/v1/policies      -> { data: Policy[], total: number }
 *   - GET /api/v1/policies/[id] -> { data: Policy }
 * Each Policy (toExternalPolicy) has top-level `id`, `name`, `isDefault`,
 * and a nested `compensation.salaryType`.
 */

type ExternalPolicy = {
  id: string
  organizationId: string
  name: string
  description: string | null
  isDefault: boolean
  archived: boolean
  moduleAccess: {
    attendance: boolean
    claims: boolean
    leave: boolean
  }
  compensation: {
    salaryType: string
    otEnabled: boolean
    otMethod: string
  }
  attendance: {
    requireGeofence: boolean
    requireSelfie: boolean
    temporary: boolean
  }
  otRates: {
    normalDay: number
    restDay: number
    publicHoliday: number
    restDayInShift: number
    publicHolidayInShift: number
    salaryThreshold: number | null
    dailyThresholdMinutes: number
  }
  employeeCount: number | null
}

type PolicyListResponse = {
  data: ExternalPolicy[]
  total: number
}

type PolicyResponse = {
  data: ExternalPolicy
}

describeSmoke("policies API smoke (read-only)", () => {
  it("lists policies with the documented envelope and shape", async () => {
    const res = await apiGet<PolicyListResponse>("/api/v1/policies")

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(typeof res.body.total).toBe("number")
    expect(res.body.total).toBe(res.body.data.length)

    // Shape-check the first policy if the org has any.
    const first = res.body.data[0]
    if (first) {
      expect(typeof first.id).toBe("string")
      expect(first.id.length).toBeGreaterThan(0)
      expect(typeof first.name).toBe("string")
      expect(typeof first.isDefault).toBe("boolean")
      expect(typeof first.compensation).toBe("object")
      expect(typeof first.compensation.salaryType).toBe("string")
    }
  })

  it("respects ?archived=false by returning only non-archived policies", async () => {
    const res = await apiGet<PolicyListResponse>(
      "/api/v1/policies?archived=false",
    )

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    for (const policy of res.body.data) {
      expect(policy.archived).toBe(false)
    }
  })

  it("reads a single policy by id when one exists", async () => {
    const list = await apiGet<PolicyListResponse>("/api/v1/policies")
    expect(list.status).toBe(200)

    const id = list.body.data[0]?.id
    if (!id) {
      // Empty org — nothing to fetch by id. Skip the per-id assertions
      // rather than fail; the list test above already covered the envelope.
      return
    }

    const res = await apiGet<PolicyResponse>(`/api/v1/policies/${id}`)
    expect(res.status).toBe(200)
    expect(typeof res.body.data).toBe("object")
    expect(res.body.data.id).toBe(id)
    expect(typeof res.body.data.name).toBe("string")
    expect(typeof res.body.data.isDefault).toBe("boolean")
    expect(typeof res.body.data.compensation.salaryType).toBe("string")
  })

  it("returns 404 with an error envelope for an unknown policy id", async () => {
    const res = await apiGet<{ error: { status: number; message: string } }>(
      "/api/v1/policies/00000000-0000-0000-0000-000000000000",
    )

    expect(res.status).toBe(404)
    expect(res.body.error.status).toBe(404)
    expect(typeof res.body.error.message).toBe("string")
  })
})
