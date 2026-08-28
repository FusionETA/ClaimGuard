import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { safeErrorMessage } from "@/lib/errors"
import { rejectPayrollRunApprovalInOrg } from "@/modules/payroll/application/services/payroll-run.service"

import { resolveAdminActor } from "../../_shared"

type RouteParams = { id: string }

/**
 * POST /api/v1/payroll-runs/[id]/reject — PENDING_APPROVAL → DRAFT.
 *
 * The approver sends a run back for editing. Fully reversible: payslips
 * and claim attachments stay attached, and the submitter edits and
 * resubmits. `reason` persists on the run as both audit and a hint to
 * the submitter.
 *
 * ## This is NOT "revert a submitted run"
 *
 * Only a run in PENDING_APPROVAL can be bounced here. Taking an already
 * APPROVED/SUBMITTED run back to draft is a different operation that
 * **cascades to every later submitted month in the same year** — their
 * YTD PCB and SOCSO/EIS relief depend on this one — and it is
 * deliberately not exposed over the API. That belongs in the admin UI
 * where the confirm dialog names the months it will drag back with it.
 *
 * Body:
 *   { "rejectedByUserId" | "rejectedByEmail", "reason"?: string }
 *
 * Sending a run back is an approver's decision, so the caller names an
 * eligible person and we verify eligibility — the same assertion model
 * as `/approve`. Note the schema has **no column for the rejector**:
 * only `approvalRejectionReason` is stored, so the identity is checked
 * but not recorded. Put the person's name in `reason` if you need it in
 * the audit trail.
 *
 * Errors: 400 malformed · 403 not eligible · 409 run isn't awaiting
 * approval.
 *
 * Scope: `payroll:write`.
 */
const bodySchema = z
  .object({
    rejectedByUserId: z.string().trim().min(1).optional(),
    rejectedByEmail: z.string().trim().toLowerCase().email().optional(),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.rejectedByUserId && !data.rejectedByEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rejectedByUserId"],
        message:
          "Provide rejectedByUserId or rejectedByEmail. Both are listed by GET /api/v1/admins.",
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
      userId: parsed.data.rejectedByUserId,
      email: parsed.data.rejectedByEmail,
      role: "rejector",
    })
    if (!actor.ok) return actor.response

    try {
      await rejectPayrollRunApprovalInOrg({
        runId,
        organizationId,
        reason: parsed.data.reason ?? null,
      })
    } catch (error) {
      return jsonError(
        409,
        safeErrorMessage(error, "Could not send this run back to draft."),
      )
    }

    return NextResponse.json({ data: { id: runId, status: "DRAFT" } })
  },
)

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
