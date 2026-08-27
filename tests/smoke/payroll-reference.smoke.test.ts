import { expect, it } from "vitest"

import { apiGet, describeSmoke } from "./helpers/client"

/**
 * Read-only smoke coverage for the payroll reference + reporting reads:
 *   GET /api/v1/payroll/adjustment-categories
 *   GET /api/v1/loans
 *   GET /api/v1/employees/[id]/salary-history
 *   GET /api/v1/payroll-runs/[id]/readiness
 *
 * All require `payroll:read`.
 */

type Category = {
  code: string
  label: string
  group: string
  kind: "ALLOWANCE" | "DEDUCTION" | "REIMBURSEMENT"
  subjectToEpf: boolean
  subjectToSocso: boolean
  subjectToEis: boolean
  subjectToPcb: boolean
  subjectToHrdf: boolean
}

type Loan = {
  id: string
  principalAmount: number
  installmentAmount: number
  installmentCount: number
  schedule: number[]
  status: string
}

type Readiness = {
  ok: boolean
  orgIssues: Array<{ field: string; label: string }>
  employeeIssues: Array<{ employeeCode: string; name: string; missing: string[] }>
  totalMissingCount: number
}

describeSmoke("payroll reference API smoke (read-only)", () => {
  it("serves the adjustment-category dictionary", async () => {
    const res = await apiGet<{
      data: Category[]
      total: number
      groups: Array<{ group: string; codes: string[] }>
    }>("/api/v1/payroll/adjustment-categories")

    expect(res.status, "needs `payroll:read` on the smoke token").toBe(200)
    expect(res.body.total).toBe(res.body.data.length)
    expect(res.body.total).toBeGreaterThan(0)

    for (const c of res.body.data) {
      expect(typeof c.code).toBe("string")
      expect(typeof c.label).toBe("string")
      expect(["ALLOWANCE", "DEDUCTION", "REIMBURSEMENT"]).toContain(c.kind)
      // All five statutory flags must be booleans. An undefined flag
      // would be read as false and silently under-contribute.
      for (const flag of [
        "subjectToEpf",
        "subjectToSocso",
        "subjectToEis",
        "subjectToPcb",
        "subjectToHrdf",
      ] as const) {
        expect(typeof c[flag], `${c.code}.${flag}`).toBe("boolean")
      }
    }

    // Every code appears in exactly one group bucket.
    const grouped = res.body.groups.flatMap((g) => g.codes)
    expect(grouped.length).toBe(res.body.data.length)
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it("distinguishes annual from non-annual bonus on SOCSO and EIS", async () => {
    // This is the contract the whole adjustment flow rests on: the two
    // categories an agent could pick from the word "bonus" must differ,
    // or picking wrong would be harmless and the confirmation step
    // pointless. If this ever stops being true, the dictionary has
    // silently lost the distinction it exists to express.
    const res = await apiGet<{ data: Category[] }>(
      "/api/v1/payroll/adjustment-categories",
    )
    expect(res.status).toBe(200)

    const byCode = new Map(res.body.data.map((c) => [c.code, c]))
    const annual = byCode.get("wages_bonus_annual")
    const nonAnnual = byCode.get("wages_bonus_non_annual")

    expect(annual, "wages_bonus_annual missing from the dictionary").toBeTruthy()
    expect(nonAnnual, "wages_bonus_non_annual missing").toBeTruthy()
    if (!annual || !nonAnnual) return

    expect(annual.subjectToSocso).toBe(false)
    expect(annual.subjectToEis).toBe(false)
    expect(nonAnnual.subjectToSocso).toBe(true)
    expect(nonAnnual.subjectToEis).toBe(true)
    // Both are EPF-subject — the flags differ, the EPF treatment doesn't.
    expect(annual.subjectToEpf).toBe(true)
    expect(nonAnnual.subjectToEpf).toBe(true)
  })

  it("lists loans and filters to active ones", async () => {
    const all = await apiGet<{ data: Loan[]; total: number }>("/api/v1/loans")
    expect(all.status, "needs `payroll:read`").toBe(200)
    expect(all.body.total).toBe(all.body.data.length)

    for (const loan of all.body.data) {
      expect(typeof loan.principalAmount).toBe("number")
      expect(typeof loan.installmentAmount).toBe("number")
      // The schedule is what makes an outstanding balance computable
      // without a second call.
      expect(Array.isArray(loan.schedule)).toBe(true)
      expect(loan.schedule.length).toBe(loan.installmentCount)
    }

    const active = await apiGet<{ data: Loan[] }>("/api/v1/loans?status=ACTIVE")
    expect(active.status).toBe(200)
    for (const loan of active.body.data) {
      expect(loan.status).toBe("ACTIVE")
    }
  })

  it("rejects an unknown loan status", async () => {
    expect((await apiGet("/api/v1/loans?status=PAID_OFF")).status).toBe(400)
  })

  it("returns salary history for an employee and 404s a foreign id", async () => {
    const list = await apiGet<{ data: Array<{ id: string }> }>(
      "/api/v1/employees?limit=1",
    )
    if (list.status !== 200 || !list.body.data[0]) return

    const res = await apiGet<{
      data: Array<{
        effectiveDate: string
        newSalaryType: string
        reason: string
      }>
      total: number
    }>(`/api/v1/employees/${list.body.data[0].id}/salary-history`)

    expect(res.status, "needs `payroll:read`").toBe(200)
    expect(res.body.total).toBe(res.body.data.length)
    for (const change of res.body.data) {
      expect(typeof change.effectiveDate).toBe("string")
      expect(typeof change.newSalaryType).toBe("string")
    }

    expect(
      (await apiGet("/api/v1/employees/clnotarealid000000000000/salary-history"))
        .status,
    ).toBe(404)
  })

  it("reports run readiness, and 404s an unknown run", async () => {
    const runs = await apiGet<{ data: Array<{ id: string }> }>(
      "/api/v1/payroll-runs?limit=1",
    )
    if (runs.status !== 200 || !runs.body.data?.[0]) return

    const res = await apiGet<{ data: Readiness }>(
      `/api/v1/payroll-runs/${runs.body.data[0].id}/readiness`,
    )
    expect(res.status, "needs `payroll:read`").toBe(200)

    const r = res.body.data
    expect(typeof r.ok).toBe("boolean")
    expect(Array.isArray(r.orgIssues)).toBe(true)
    expect(Array.isArray(r.employeeIssues)).toBe(true)

    const counted =
      r.orgIssues.length +
      r.employeeIssues.reduce((sum, e) => sum + e.missing.length, 0)
    expect(r.totalMissingCount).toBe(counted)
    // `ok` must agree with the count — a caller gating a submit on `ok`
    // while the list is non-empty would be the worst possible bug here.
    expect(r.ok).toBe(counted === 0)

    // A run outside this org is 404, never a pass.
    expect(
      (await apiGet("/api/v1/payroll-runs/clnotarealrunid00000000/readiness"))
        .status,
    ).toBe(404)
  })
})
