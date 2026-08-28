import { expect, it } from "vitest"

import { api, apiGet, apiPost, describeSmoke } from "./helpers/client"

/**
 * Smoke coverage for the payroll WRITE endpoints:
 *   POST /api/v1/payroll-runs/[id]/adjustments
 *   POST /api/v1/payroll-runs/[id]/submit
 *   POST /api/v1/payroll-runs/[id]/reject
 *   POST /api/v1/payroll-runs/[id]/revert
 *
 * ## Deliberately negative-path only
 *
 * These four move money and freeze statutory figures. A smoke suite that
 * exercised the happy path would need a real draft run with generated
 * payslips, and would leave the smoke org's payroll in whatever state it
 * crashed in — so nothing here mutates anything.
 *
 * What it does cover is the guard rails, which is precisely what an
 * integrating caller hits first: required fields, the category/kind
 * agreement check, actor eligibility, and the state machine. A caller
 * that gets these responses right will get the happy path right; a
 * caller that mistakes a 409 for success will not.
 *
 * Happy paths belong in a manual pass against a real draft run before
 * anyone integrates.
 */

const NO_SUCH_RUN = "clnotarealpayrollrunid00"
const NO_SUCH_EMPLOYEE = "clnotarealemployeeprof00"

describeSmoke("payroll write endpoints smoke (guard rails only)", () => {
  it("the smoke token carries payroll:write", async () => {
    // Asserted once, up front: without this scope every test below
    // returns 403 and the failures read as bugs rather than as a
    // mis-scoped token.
    const res = await apiGet<{ data: { scopes: string[] } }>("/api/v1/whoami")
    expect(res.status).toBe(200)
    expect(
      res.body.data.scopes,
      "grant `payroll:write` to the smoke token or these suites are meaningless",
    ).toContain("payroll:write")
  })

  it("advertises every payroll write flag on whoami", async () => {
    const res = await apiGet<{ data: { features: string[] } }>("/api/v1/whoami")
    expect(res.status).toBe(200)
    for (const flag of [
      "payroll.adjustments",
      "payroll.submit",
      "payroll.reject",
      "payroll.revert",
      "payroll.readiness",
    ]) {
      expect(res.body.data.features, `missing flag ${flag}`).toContain(flag)
    }
  })

  // ── adjustments ────────────────────────────────────────────────────

  it("rejects an adjustment with no category", async () => {
    const res = await apiPost(
      `/api/v1/payroll-runs/${NO_SUCH_RUN}/adjustments`,
      {
        employeeProfileId: NO_SUCH_EMPLOYEE,
        kind: "ALLOWANCE",
        label: "Bonus",
        amount: 4000,
      },
    )
    // Category has no default on purpose — falling back to
    // allowance_standard would book a bonus with the wrong statutory
    // treatment and the wrong PCB method.
    expect(res.status).toBe(400)
  })

  it("rejects an unknown category", async () => {
    const res = await apiPost(
      `/api/v1/payroll-runs/${NO_SUCH_RUN}/adjustments`,
      {
        employeeProfileId: NO_SUCH_EMPLOYEE,
        kind: "ALLOWANCE",
        category: "wages_christmas_bonus",
        label: "Bonus",
        amount: 4000,
      },
    )
    expect(res.status).toBe(400)
  })

  it("rejects a kind that disagrees with the category", async () => {
    const res = await apiPost<{ error: { message: string } }>(
      `/api/v1/payroll-runs/${NO_SUCH_RUN}/adjustments`,
      {
        employeeProfileId: NO_SUCH_EMPLOYEE,
        // A deduction category sent as an allowance — silently booking
        // this the wrong way round would flip the sign of the money.
        kind: "ALLOWANCE",
        category: "deduct_advance",
        label: "Advance",
        amount: 100,
      },
    )
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/DEDUCTION/)
  })

  it("rejects a non-positive amount and unknown keys", async () => {
    const zero = await apiPost(
      `/api/v1/payroll-runs/${NO_SUCH_RUN}/adjustments`,
      {
        employeeProfileId: NO_SUCH_EMPLOYEE,
        kind: "ALLOWANCE",
        category: "wages_bonus_annual",
        label: "Bonus",
        amount: 0,
      },
    )
    expect(zero.status).toBe(400)

    const extra = await apiPost(
      `/api/v1/payroll-runs/${NO_SUCH_RUN}/adjustments`,
      {
        employeeProfileId: NO_SUCH_EMPLOYEE,
        kind: "ALLOWANCE",
        category: "wages_bonus_annual",
        label: "Bonus",
        amount: 100,
        // `.strict()` — a typo'd key must 400, not be ignored.
        treatAsRecuring: true,
      },
    )
    expect(extra.status).toBe(400)
  })

  it("404s a dry run against a run that isn't in this org", async () => {
    const res = await apiPost(
      `/api/v1/payroll-runs/${NO_SUCH_RUN}/adjustments`,
      {
        employeeProfileId: NO_SUCH_EMPLOYEE,
        kind: "ALLOWANCE",
        category: "wages_bonus_annual",
        label: "Bonus",
        amount: 4000,
        dryRun: true,
      },
    )
    // Never 200-with-zeroes: "couldn't compute" must not read as
    // "no change".
    expect(res.status).toBe(404)
  })

  // ── state transitions ──────────────────────────────────────────────

  it("submit requires a named submitter", async () => {
    const res = await apiPost(`/api/v1/payroll-runs/${NO_SUCH_RUN}/submit`, {})
    expect(res.status).toBe(400)
  })

  it("submit 403s an email that isn't an admin of this org", async () => {
    const res = await apiPost(`/api/v1/payroll-runs/${NO_SUCH_RUN}/submit`, {
      submittedByEmail: "definitely-not-an-admin@example.com",
    })
    // Eligibility is checked before the run is even looked at, so this
    // is 403 rather than 404 — and the message must not reveal whether
    // the user exists.
    expect(res.status).toBe(403)
  })

  it("reject requires a named rejector", async () => {
    const res = await apiPost(`/api/v1/payroll-runs/${NO_SUCH_RUN}/reject`, {
      reason: "numbers look wrong",
    })
    expect(res.status).toBe(400)
  })

  it("revert requires a named admin", async () => {
    const res = await apiPost(`/api/v1/payroll-runs/${NO_SUCH_RUN}/revert`, {})
    expect(res.status).toBe(400)
  })

  it("rejects a non-object body on every transition", async () => {
    for (const path of ["submit", "reject", "revert"]) {
      const res = await api(
        "POST",
        `/api/v1/payroll-runs/${NO_SUCH_RUN}/${path}`,
        // The client JSON-encodes this, so it arrives as a valid JSON
        // *string* — it parses fine and then fails the object schema.
        // That is the case being asserted: a body of the wrong SHAPE
        // must 400 rather than be coerced into an empty object.
        "not an object",
      )
      expect([400, 403], `${path} on a non-object body`).toContain(res.status)
    }
  })
})
