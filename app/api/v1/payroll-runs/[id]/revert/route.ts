import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { revertSubmittedRunToDraftInOrg } from "@/modules/payroll/application/services/payroll-run.service"

import { resolveAdminActor } from "../../_shared"

type RouteParams = { id: string }

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

/**
 * POST /api/v1/payroll-runs/[id]/revert — SUBMITTED → DRAFT, but only
 * when this run is the last submitted month of its year.
 *
 * ## Why the restriction
 *
 * Later submitted months carry YTD-cumulative PCB and SOCSO/EIS relief
 * that depends on this one, so the in-app revert CASCADES them back to
 * draft as well. That is safe in the UI because the confirm dialog
 * names every month it will affect and a human accepts it. Over the API
 * there is no such moment — a caller reopening March would not expect
 * April through August to reopen with it, and an agent relaying "done"
 * would be reporting something much larger than what was asked.
 *
 * So: no cascade over the API. If later submitted months exist we
 * refuse with 409 and return them in `details.laterRuns`, and the
 * caller should name those months and send the person into AltomateHR,
 * where the consequence is visible before it happens.
 *
 * The year boundary is deliberate, not an oversight: YTD resets in
 * January, so a run in the following year carries no dependency on this
 * one and never blocks.
 *
 * ## The other two transitions
 *
 * DRAFT → PENDING_APPROVAL is `/submit`; PENDING_APPROVAL → DRAFT is
 * `/reject`. This route handles neither — a run in either state gets a
 * 409 naming its current status and the route that does apply.
 *
 * Body: { "revertedByUserId" | "revertedByEmail" }
 *
 * As with `/reject`, we verify the named person is an eligible admin
 * but the schema has no column to record who reverted — only the status
 * change lands. Worth knowing before relying on this for audit.
 *
 * Scope: `payroll:write`.
 */
const bodySchema = z
  .object({
    revertedByUserId: z.string().trim().min(1).optional(),
    revertedByEmail: z.string().trim().toLowerCase().email().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.revertedByUserId && !data.revertedByEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revertedByUserId"],
        message:
          "Provide revertedByUserId or revertedByEmail. Both are listed by GET /api/v1/admins.",
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
      userId: parsed.data.revertedByUserId,
      email: parsed.data.revertedByEmail,
      role: "reverting admin",
    })
    if (!actor.ok) return actor.response

    const result = await revertSubmittedRunToDraftInOrg({
      runId,
      organizationId,
    })

    if (result.ok) {
      return NextResponse.json({ data: { id: runId, status: "DRAFT" } })
    }

    if (result.reason === "NOT_FOUND") {
      return jsonError(404, "Payroll run not found.")
    }

    if (result.reason === "NOT_SUBMITTED") {
      const hint =
        result.status === "PENDING_APPROVAL"
          ? " It is awaiting approval — use POST /api/v1/payroll-runs/{id}/reject to send it back to draft."
          : result.status === "DRAFT"
            ? " It is already a draft."
            : ""
      return jsonError(
        409,
        `Only submitted runs can be reverted; this run is ${result.status}.${hint}`,
      )
    }

    // LATER_RUNS_EXIST — refuse, and hand back what blocked it so the
    // caller can name the months rather than say "it didn't work".
    const labels = result.laterRuns.map(
      (r) => `${MONTHS[r.periodMonth - 1]} ${r.periodYear}`,
    )
    return NextResponse.json(
      {
        error: {
          status: 409,
          message: `This run isn't the latest submitted month — ${labels.join(", ")} ${
            labels.length === 1 ? "was" : "were"
          } submitted after it and depend on its year-to-date figures. Reverting here would drag ${
            labels.length === 1 ? "it" : "them"
          } back to draft too, so it has to be done in AltomateHR (Payroll → Runs), where the affected months are confirmed first.`,
          details: { laterRuns: result.laterRuns, laterRunLabels: labels },
        },
      },
      { status: 409 },
    )
  },
)

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
