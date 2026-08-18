import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { safeErrorMessage } from "@/lib/errors"
import { approvePayrollRunAsUser } from "@/modules/payroll/application/services/payroll-run.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * POST /api/v1/payroll-runs/[id]/approve
 *
 * Required scope: `payroll:write`.
 *
 * Body — exactly one identifier is required:
 *   { "approvedByUserId": "ckxxxxxxxxxxxxxxxxxx" }
 *   { "approvedByEmail": "owner@acme.com" }
 *
 * Both are discoverable via GET /api/v1/admins. `approvedByEmail` exists
 * because callers (and AI agents) know people by email, not by cuid; it
 * is resolved to a user id and then put through the SAME authorisation
 * gate, so there is exactly one place that decides who may approve.
 *
 * Transitions the run PENDING_APPROVAL → SUBMITTED. The approver is the
 * human user that authorised the approval — the external system passes
 * this back so the audit trail records a real person rather than an
 * opaque API token. We validate the user:
 *   1. exists in the integration's organisation
 *   2. has role ADMIN or OWNER (the same gate the in-app UI uses)
 *
 * NOTE: this is an assertion, not authentication. We verify the named
 * person is ELIGIBLE to approve, not that they actually did — the token
 * holder is trusted to report the real approver.
 *
 * If the org has `syncPayrollToXeroOnSubmit` enabled, the journal post
 * happens best-effort after the status flip — the run still ends up
 * SUBMITTED even if Xero is unreachable. The Xero outcome is returned
 * in the response so callers can surface it to their own users.
 *
 * Error responses:
 *   400 — malformed body / neither identifier supplied
 *   404 — run not found in this org
 *   403 — approver not in this org, or not an admin/owner
 *   409 — run is not in PENDING_APPROVAL state
 *   500 — unexpected server error
 */
const bodySchema = z
  .object({
    approvedByUserId: z.string().trim().min(1).optional(),
    approvedByEmail: z.string().trim().toLowerCase().email().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.approvedByUserId && !data.approvedByEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedByUserId"],
        message:
          "Provide approvedByUserId or approvedByEmail. Both are listed by GET /api/v1/admins.",
      })
    }
  })

export const POST = handleApiRequest<{ id: string }>(
  ["payroll:write"],
  async (request, ctx) => {
    const { id: runId } = ctx.params

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: { status: 400, message: "Invalid JSON body." } },
        { status: 400 },
      )
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

    // Approver must be an ADMIN / OWNER with access to the
    // integration's org. `findAdminWithAccessToOrg` accepts BOTH
    // routes an admin uses to gain access:
    //   - their primary org (`User.organizationId === orgId`), or
    //   - a linked admin row (`AdminOrganization { adminId, orgId }`)
    // so multi-tenant admins (whose home org differs from the org
    // being approved) are recognised. Prior implementation called
    // `findOrgMemberById` which only matched the primary path, and
    // 403'd legitimate multi-org admins.
    // Resolve an email to a user id first. The email is used ONLY for
    // lookup — the authorisation check below is unchanged, so both
    // identifiers converge on a single gate.
    let approverId = parsed.data.approvedByUserId ?? null
    const approverEmail = parsed.data.approvedByEmail
    if (!approverId && approverEmail) {
      const admins = await organizationRepository.listAdminsForOrganization(
        ctx.integration.organizationId,
      )
      approverId =
        admins.find((a) => a.email.toLowerCase() === approverEmail)?.id ?? null
    }

    const approver = approverId
      ? await organizationRepository.findAdminWithAccessToOrg({
          userId: approverId,
          organizationId: ctx.integration.organizationId,
        })
      : null
    if (!approver) {
      // Collapse "user not found", "not an admin", and "no access to
      // this org" into a single message — don't enumerate which
      // condition failed, that leaks org membership.
      return NextResponse.json(
        {
          error: {
            status: 403,
            message:
              "The approver does not have admin access to this organisation. The user must have role ADMIN or OWNER and be linked to this org as their primary or via AdminOrganization. List valid approvers with GET /api/v1/admins.",
          },
        },
        { status: 403 },
      )
    }

    try {
      const result = await approvePayrollRunAsUser({
        organizationId: ctx.integration.organizationId,
        runId,
        approverId: approver.id,
      })
      return NextResponse.json({
        data: {
          runId,
          status: "SUBMITTED",
          approvedBy: {
            id: approver.id,
            name: approver.name,
            email: approver.email,
            role: approver.role,
          },
          xeroSync: result.xeroSync ?? null,
        },
      })
    } catch (err) {
      const message = safeErrorMessage(err, "Could not approve this run.")
      const lower = message.toLowerCase()
      const status = lower.includes("not found")
        ? 404
        : lower.includes("awaiting approval") ||
            lower.includes("only runs awaiting")
          ? 409
          : 500
      return NextResponse.json(
        { error: { status, message } },
        { status },
      )
    }
  },
)
