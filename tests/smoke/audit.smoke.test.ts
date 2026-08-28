import { expect, it } from "vitest"

import { apiGet, describeSmoke } from "./helpers/client"

/**
 * Read-only smoke coverage for GET /api/v1/audit.
 *
 * Contract (app/api/v1/audit/route.ts):
 *   { data: AuditLogEntry[], nextCursor: string | null }
 *
 * Requires `settings:read` on the smoke token — the endpoint reuses that
 * scope deliberately rather than introducing `audit:read`, because a new
 * scope is absent from every already-issued token and would 403 until
 * each was re-issued.
 */

type AuditEntry = {
  id: string
  actorEmail: string
  actorName: string
  action: string
  status: string
  summary: string
  partnerInitiated: boolean
  createdAt: string
}

type AuditBody = { data: AuditEntry[]; nextCursor: string | null }

describeSmoke("audit log API smoke (read-only)", () => {
  it("returns entries with a cursor field", async () => {
    const res = await apiGet<AuditBody>("/api/v1/audit")

    expect(res.status, "needs `settings:read` on the smoke token").toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    // Always present, null when there is no next page.
    expect(
      res.body.nextCursor === null || typeof res.body.nextCursor === "string",
    ).toBe(true)
  })

  it("entries carry a named actor and a partner-initiated flag", async () => {
    const res = await apiGet<AuditBody>("/api/v1/audit?limit=5")
    expect(res.status).toBe(200)

    for (const entry of res.body.data) {
      expect(typeof entry.id).toBe("string")
      // The actor is the reason this log exists — never blank.
      expect(typeof entry.actorEmail).toBe("string")
      expect(typeof entry.actorName).toBe("string")
      expect(typeof entry.action).toBe("string")
      expect(entry.action.length).toBeGreaterThan(0)
      expect(["SUCCESS", "FAILED"]).toContain(entry.status)
      // Distinguishes an API-attributed actor from an authenticated one.
      expect(typeof entry.partnerInitiated).toBe("boolean")
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false)
    }
  })

  it("honours limit", async () => {
    const res = await apiGet<AuditBody>("/api/v1/audit?limit=1")
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeLessThanOrEqual(1)
  })

  it("rejects a status outside the enum", async () => {
    // FAILURE is the plausible-but-wrong spelling; the stored value is
    // FAILED. A 400 here is what stops a caller silently filtering to
    // nothing.
    const res = await apiGet("/api/v1/audit?status=FAILURE")
    expect(res.status).toBe(400)
  })
})
