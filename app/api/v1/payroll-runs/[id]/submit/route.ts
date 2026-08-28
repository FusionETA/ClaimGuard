import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { safeErrorMessage } from "@/lib/errors"
import { submitPayrollRunForApprovalInOrg } from "@/modules/payroll/application/services/payroll-run.service"

import { resolveAdminActor } from "../../_shared"

type RouteParams = { id: string }

/**
 * POST /api/v1/payroll-runs/[id]/submit — DRAFT → PENDING_APPROVAL.
 *
 * Hands a finished draft to an approver. This is the transition an
 * agent SHOULD be able to drive: it is assembly finished, not
 * authorisation given, and it is reversible via
 * `POST /api/v1/payroll-runs/[id]/reject`. Approval itself remains a
 * separate act on a separate route.
 *
 * Body — exactly one identifier:
 *   { "submittedByUserId": "clx…" }  or  { "submittedByEmail": "…" }
 *
 * `submittedForApprovalById` is a real column, so the submitter has to
 * be named. As with `/approve`, we verify the named person is eligible
 * (ADMIN or OWNER with access to this org) but not that they actually
 * asked — see `resolveAdminActor`.
 *
 * ## The guards are the point
 *
 * Four checks run before the status moves, and a 409 here is the system
 * working: the draft is stale (inputs changed since payroll was last
 * generated), the run has no payslips, an earlier month hasn't been
 * submitted (skipping it would freeze this month's PCB / EPF / SOCSO
 * against zero YTD), or statutory fields are missing. The last one is
 * the same check `GET /api/v1/payroll-runs/[id]/readiness` reports, so
 * call that FIRST and fix what it names — the messages here are
 * actionable but arrive later than they need to.
 *
 * Errors: 400 malformed body · 403 submitter not eligible ·
 * 409 a guard refused, or the run isn't in DRAFT.
 *
 * Scope: `payroll:write`.
 */
const bodySchema = z
  .object({
    submittedByUserId: z.string().trim().min(1).optional(),
    submittedByEmail: z.string().trim().toLowerCase().email().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.submittedByUserId && !data.submittedByEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["submittedByUserId"],
        message:
          "Provide submittedByUserId or submittedByEmail. Both are listed by GET /api/v1/admins.",
      })
    }
  })

export const POST = handleApiRequest<RouteParams>(
  ["payroll:write"],
  async (request, ctx) => {
    const { id: runId } = ctx.params
    if (!runId) return jsonError(400, "Missing payroll run id.")

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = bodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            status: 400,
            message: "Validation failed.",
            details: parsed.error.flatten(),
          },
        },
        { status: 400 },
      )
    }

    const organizationId = ctx.integration.organizationId
    const actor = await resolveAdminActor({
      organizationId,
      userId: parsed.data.submittedByUserId,
      email: parsed.data.submittedByEmail,
      role: "submitter",
    })
    if (!actor.ok) return actor.response

    try {
      await submitPayrollRunForApprovalInOrg({
        runId,
        organizationId,
        submittedById: actor.userId,
      })
    } catch (error) {
      // Every guard throws with an actionable message — pass it through
      // verbatim rather than flattening it to "could not submit".
      return jsonError(
        409,
        safeErrorMessage(error, "Could not submit this run for approval."),
      )
    }

    return NextResponse.json({
      data: { id: runId, status: "PENDING_APPROVAL" },
    })
  },
)

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
