import { expect, it } from "vitest"

import { apiGet, describeSmoke } from "./helpers/client"

/**
 * Read-only smoke suite for the chart-of-accounts API.
 *
 * Granted scope: `chart-of-accounts:read` only — no write scope, so this
 * suite never creates or deletes. It exercises the collection endpoint
 * (plain + ?onlyCustom=true + ?selectableOnly=true) and, when the org has
 * at least one account, the single-resource GET.
 */

type ExternalAccount = {
  id: string
  code: string
  name: string
  type: string | null
  status: string | null
  isCustom: boolean
  isSelectable: boolean
  isBankAccount: boolean
  isDisabled: boolean
  limit:
    | null
    | {
        amount: number
        period: string | null
        scope: string | null
      }
  mileage: {
    allowMileageClaim: boolean
    mileageRate: number | null
  }
}

type ListResponse = { data: ExternalAccount[]; total: number }
type SingleResponse = { data: ExternalAccount }

function assertAccountShape(account: ExternalAccount): void {
  expect(typeof account.id).toBe("string")
  expect(account.id.length).toBeGreaterThan(0)
  expect(typeof account.code).toBe("string")
  expect(typeof account.name).toBe("string")
  // type may be null but the key must be present.
  expect("type" in account).toBe(true)
  expect(typeof account.isCustom).toBe("boolean")
  expect(typeof account.isSelectable).toBe("boolean")
  expect(typeof account.isBankAccount).toBe("boolean")
  expect(typeof account.isDisabled).toBe("boolean")
  expect("limit" in account).toBe(true)
  expect(account.mileage).toBeTruthy()
  expect(typeof account.mileage.allowMileageClaim).toBe("boolean")
}

describeSmoke("chart-of-accounts API smoke", () => {
  it("lists chart accounts with the { data, total } envelope and valid shape", async () => {
    const res = await apiGet<ListResponse>("/api/v1/chart-of-accounts")
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(typeof res.body.total).toBe("number")
    expect(res.body.total).toBe(res.body.data.length)

    for (const account of res.body.data) {
      assertAccountShape(account)
    }
  })

  it("supports ?onlyCustom=true and returns only custom accounts", async () => {
    const res = await apiGet<ListResponse>(
      "/api/v1/chart-of-accounts?onlyCustom=true",
    )
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.total).toBe(res.body.data.length)

    for (const account of res.body.data) {
      assertAccountShape(account)
      expect(account.isCustom).toBe(true)
    }
  })

  it("supports ?selectableOnly=true and returns only selectable accounts", async () => {
    const res = await apiGet<ListResponse>(
      "/api/v1/chart-of-accounts?selectableOnly=true",
    )
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.total).toBe(res.body.data.length)

    for (const account of res.body.data) {
      assertAccountShape(account)
      expect(account.isSelectable).toBe(true)
    }
  })

  it("reads a single chart account by id when one exists", async () => {
    const list = await apiGet<ListResponse>("/api/v1/chart-of-accounts?selectableOnly=true")
    expect(list.status).toBe(200)

    const first = list.body.data[0]
    if (!first) {
      // No accounts configured for this org — nothing to read. The list
      // assertions above already covered the empty-envelope case.
      return
    }

    const res = await apiGet<SingleResponse>(
      `/api/v1/chart-of-accounts/${first.id}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.data).toBeTruthy()
    expect(res.body.data.id).toBe(first.id)
    assertAccountShape(res.body.data)
  })
})
