import { expect, it } from "vitest"

import { apiGet, describeSmoke } from "./helpers/client"

/**
 * Claims API — READ-ONLY smoke.
 *
 * This module is intentionally read-only. The granted token scopes are
 * `claims:read` and `claims:write`, but:
 *   - There is NO DELETE route for claims (only GET list, GET [id], and a
 *     POST [id]/review action). A claim created via POST /api/v1/claims
 *     therefore cannot be cleaned up through the API, which would leave a
 *     permanent fixture in the Smoke Test Co org — so we do NOT create one.
 *   - The only state-changing claim endpoint, POST /api/v1/claims/[id]/review,
 *     requires the `approvals:write` scope, which this smoke token does NOT
 *     hold.
 * Hence this suite only exercises the read endpoints and asserts envelopes.
 */

/** External claim projection (subset of `toExternalClaim` in _shared.ts). */
type ExternalClaim = {
  id: string
  claimNumber: string
  title: string
  status: string
  claimType: "EXPENSE" | "MILEAGE"
  paymentType: string
  amount: number
  currency: string
  employee: {
    id: string
    employeeId: string
    name: string
    email: string
  }
}

type ClaimsList = {
  data: ExternalClaim[]
  pagination: {
    total: number
    limit: number
    offset: number
    hasMore: boolean
  }
}

type ClaimEnvelope = { data: ExternalClaim }

describeSmoke("claims API smoke (read-only)", () => {
  it("lists claims with the { data, pagination } envelope", async () => {
    const res = await apiGet<ClaimsList>("/api/v1/claims?limit=5")

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)

    const { pagination } = res.body
    expect(pagination).toBeTruthy()
    expect(typeof pagination.total).toBe("number")
    expect(pagination.limit).toBe(5)
    expect(typeof pagination.offset).toBe("number")
    expect(typeof pagination.hasMore).toBe("boolean")

    // The slice can never exceed the requested limit.
    expect(res.body.data.length).toBeLessThanOrEqual(pagination.limit)

    // Every returned item carries the documented core fields.
    for (const claim of res.body.data) {
      expect(typeof claim.id).toBe("string")
      expect(typeof claim.claimNumber).toBe("string")
      expect(typeof claim.status).toBe("string")
      expect(["EXPENSE", "MILEAGE"]).toContain(claim.claimType)
      expect(typeof claim.amount).toBe("number")
    }
  })

  it("reads a single claim by id when the list is non-empty", async () => {
    const list = await apiGet<ClaimsList>("/api/v1/claims?limit=1")
    expect(list.status).toBe(200)

    const first = list.body.data[0]
    if (!first) {
      // Empty org (no claims yet) — nothing to read; the list test above
      // already validated the envelope. Skip the per-id assertion.
      expect(list.body.pagination.total).toBe(0)
      return
    }

    const res = await apiGet<ClaimEnvelope>(`/api/v1/claims/${first.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toBeTruthy()
    expect(res.body.data.id).toBe(first.id)
    expect(res.body.data.claimNumber).toBe(first.claimNumber)
    expect(["EXPENSE", "MILEAGE"]).toContain(res.body.data.claimType)
    expect(typeof res.body.data.amount).toBe("number")
  })
})
