import { expect, it } from "vitest"

import { apiGet, describeSmoke } from "./helpers/client"

/**
 * Read-only smoke coverage for GET /api/v1/settings.
 *
 * The suite token carries `settings:read` ONLY — there is no
 * `settings:write` scope, so this file performs NO PATCH / mutation.
 *
 * Contract (from app/api/v1/settings/route.ts, `toExternalSettings`):
 *   { data: {
 *       id: string
 *       name: string
 *       claimCutoffDay: number
 *       otEnabled: boolean
 *       currencies: { allowed: string[]; default: string | null }
 *       mileage: { defaultRate: number | null; unit: string }
 *       geofenceRadiusMeters: number
 *   } }
 */

type OrgSettings = {
  id: string
  name: string
  claimCutoffDay: number
  otEnabled: boolean
  currencies: {
    allowed: string[]
    default: string | null
  }
  mileage: {
    defaultRate: number | null
    unit: string
  }
  geofenceRadiusMeters: number
}

describeSmoke("settings API smoke (read-only)", () => {
  it("returns org settings with the documented shape", async () => {
    const res = await apiGet<{ data: OrgSettings }>("/api/v1/settings")

    expect(res.status).toBe(200)
    expect(res.body).toBeTruthy()

    const settings = res.body.data
    expect(settings).toBeTruthy()

    // Identity + name.
    expect(typeof settings.id).toBe("string")
    expect(settings.id.length).toBeGreaterThan(0)
    expect(typeof settings.name).toBe("string")

    // Claim cutoff day is an int in [1, 31].
    expect(typeof settings.claimCutoffDay).toBe("number")
    expect(Number.isInteger(settings.claimCutoffDay)).toBe(true)
    expect(settings.claimCutoffDay).toBeGreaterThanOrEqual(1)
    expect(settings.claimCutoffDay).toBeLessThanOrEqual(31)

    // OT toggle.
    expect(typeof settings.otEnabled).toBe("boolean")

    // Currencies: { allowed: string[]; default: string | null }.
    expect(settings.currencies).toBeTruthy()
    expect(Array.isArray(settings.currencies.allowed)).toBe(true)
    for (const code of settings.currencies.allowed) {
      expect(typeof code).toBe("string")
    }
    const def = settings.currencies.default
    expect(def === null || typeof def === "string").toBe(true)
    // When both are set, default must be one of the allowed codes.
    if (def !== null && settings.currencies.allowed.length > 0) {
      expect(settings.currencies.allowed).toContain(def)
    }

    // Mileage: { defaultRate: number | null; unit: string }.
    expect(settings.mileage).toBeTruthy()
    const rate = settings.mileage.defaultRate
    expect(rate === null || typeof rate === "number").toBe(true)
    expect(typeof settings.mileage.unit).toBe("string")
    expect(settings.mileage.unit.length).toBeGreaterThan(0)

    // Geofence radius in meters.
    expect(typeof settings.geofenceRadiusMeters).toBe("number")
  })

  it("rejects an unknown sub-path under settings with a non-2xx status", async () => {
    const res = await apiGet<{ error?: { status: number; message: string } }>(
      "/api/v1/settings/does-not-exist",
    )
    expect(res.ok).toBe(false)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
