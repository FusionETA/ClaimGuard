import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { computePayrollRunReadiness } from "@/modules/payroll/application/services/payroll-readiness.service"

type RouteParams = { id: string }

/**
 * GET /api/v1/payroll-runs/[id]/readiness — what still blocks this run
 * from being submitted.
 *
 * The same check the in-app submit guard runs, so a caller can surface
 * the blockers BEFORE anyone tries to submit, instead of discovering
 * them at the point of refusal. This is the tedious pre-flight a person
 * is bad at and worth automating: it names the exact missing field on
 * the exact employee.
 *
 * Two kinds of issue come back:
 *   - `orgIssues`      — Company Info fields every statutory document
 *                        needs (employer name, LHDN E number, SSM
 *                        registration, PERKESO code). Fixed once, via
 *                        `PATCH /api/v1/payroll-settings`.
 *   - `employeeIssues` — per employee, the missing fields (payroll
 *                        number, IC for Malaysians/PRs or passport for
 *                        foreigners).
 *
 * Note what is deliberately NOT here: `incomeTaxNumber`. PCB calculates
 * without a TIN, and new joiners routinely have none yet — it's checked
 * at CP39 / PCB TXT generation time instead, so a missing TIN doesn't
 * block the monthly run. Don't report it as a blocker.
 *
 * `ok: true` means nothing is missing. A 404 means the run isn't in
 * this org — which is not the same as "ready", so don't treat an error
 * as a pass.
 *
 * Scope: `payroll:read`.
 */
export const GET = handleApiRequest<RouteParams>(
  ["payroll:read"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) {
      return NextResponse.json(
        { error: { status: 400, message: "Missing payroll run id." } },
        { status: 400 },
      )
    }

    const readiness = await computePayrollRunReadiness({
      runId: id,
      organizationId: ctx.integration.organizationId,
    })
    if (!readiness) {
      return NextResponse.json(
        { error: { status: 404, message: "Payroll run not found." } },
        { status: 404 },
      )
    }

    return NextResponse.json({ data: readiness })
  },
)
