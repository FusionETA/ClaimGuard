import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"

/**
 * Org-wide default leave entitlements.
 *
 * ## Scope: default days only, deliberately
 *
 * A leave type in AltomateHR carries far more than a day count —
 * accrual method (lump-sum vs monthly pro-rated), carry-forward with an
 * expiry month and cap, first-year proration, paid/unpaid. On top of
 * that, entitlements resolve through THREE levels:
 *
 *   1. `LeaveEntitlement`       — per employee, per year
 *   2. `PolicyLeaveEntitlement` — per policy (employee group)
 *   3. `LeaveType.defaultDays`  — org-wide fallback  ← this endpoint
 *
 * This endpoint writes level 3 and nothing else. That's the whole point:
 * an onboarding form should collect one number per leave type, and the
 * complicated cases (a group with different entitlements, carry-forward
 * rules, mid-year accrual) stay with CS, who can configure them in the
 * admin UI after talking to the client.
 *
 * Everything else is returned read-only so a partner UI can SHOW the
 * client what they're on without being able to change it by accident.
 *
 * ## The types already exist
 *
 * `ensureDefaultLeaveTypesForOrg` runs at provisioning
 * (`POST /api/v1/admin/organizations`), so every org already has the
 * eight Malaysian statutory types — Annual 14, Medical 14,
 * Hospitalization 60, Maternity 98 (EA 2022), Paternity 7,
 * Compassionate 3, Marriage 3, Unpaid 0 — before anyone sees a form.
 * So this is a PATCH over a known set, not a create-from-nothing: read
 * the GET, pre-fill the form with what's there, and send back only what
 * the client changed. There's no POST here on purpose — a new custom
 * leave type is a CS conversation, not a form field.
 *
 * Scope: `leave:read` / `leave:write`. Both are already in
 * `API_SCOPE_CATALOG` and every provisioned token holds them, so no
 * token needs re-issuing — this is the first route to actually use them.
 */

/**
 * GET /api/v1/leave-types
 *
 * Required scope: `leave:read`. Archived types are excluded — they're
 * historical and not something an onboarding form should offer.
 */
export const GET = handleApiRequest(["leave:read"], async (_request, ctx) => {
  const types = await leaveRepository.listTypes(ctx.integration.organizationId)
  return NextResponse.json({
    data: types.map(toExternalLeaveType),
    total: types.length,
  })
})

const updateLeaveTypesSchema = z
  .object({
    /// Map of leave-type CODE → default days for the whole org.
    ///
    /// Keyed by code rather than id because the codes are seeded and
    /// stable (`ANNUAL`, `MEDICAL`, `HOSPITALIZATION`, `MATERNITY`,
    /// `PATERNITY`, `COMPASSIONATE`, `MARRIAGE`, `UNPAID`), so a caller
    /// can write straight from a form without reading ids first.
    /// Codes are matched case-insensitively.
    ///
    /// Only codes you include are touched. Half-days are allowed
    /// (`defaultDays` is a Float) — 0.5 increments are common for
    /// Malaysian medical leave policies.
    entitlements: z
      .record(z.string().trim().min(1), z.number().min(0).max(365))
      .refine((v) => Object.keys(v).length > 0, {
        message: "Provide at least one leave type code.",
      }),
  })
  .strict()

/**
 * PATCH /api/v1/leave-types
 *
 * Required scope: `leave:write`. Bulk-sets org-wide default days.
 *
 * NOT atomic — each type is a separate write, so a mid-flight failure
 * leaves earlier ones applied. Every write is idempotent, so re-sending
 * the same body is the fix.
 *
 * Important: this changes the org-wide DEFAULT, which is the bottom of
 * the resolution chain. Employees who already have a `LeaveEntitlement`
 * row for the current year keep it, and any policy-level override still
 * wins. So this is the right call at onboarding, and a weak instrument
 * afterwards — if the client is already live, tell them to go through CS
 * rather than assuming this reaches existing staff.
 */
export const PATCH = handleApiRequest(["leave:write"], async (request, ctx) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, "Invalid JSON body.")
  }

  const parsed = updateLeaveTypesSchema.safeParse(body)
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

  const orgId = ctx.integration.organizationId
  // Include archived so we can tell "no such code" from "that one is
  // archived" — two different fixes for the caller.
  const allTypes = await leaveRepository.listTypes(orgId, {
    includeArchived: true,
  })
  const byCode = new Map(allTypes.map((t) => [t.code.toUpperCase(), t]))

  const requested = Object.entries(parsed.data.entitlements).map(
    ([code, days]) => ({ code: code.toUpperCase(), days }),
  )

  const unknown = requested.filter((r) => !byCode.has(r.code))
  if (unknown.length > 0) {
    return jsonError(
      400,
      `Unknown leave type code(s): ${unknown
        .map((r) => r.code)
        .join(", ")}. Known codes: ${allTypes
        .map((t) => t.code)
        .join(", ")}. Creating new leave types isn't supported here.`,
    )
  }

  const archived = requested.filter((r) => byCode.get(r.code)?.archivedAt)
  if (archived.length > 0) {
    return jsonError(
      409,
      `Archived leave type(s): ${archived
        .map((r) => r.code)
        .join(", ")}. Restore them in AltomateHR before setting entitlements.`,
    )
  }

  // Unpaid leave has no quota by design — `LeaveType.paid = false` makes
  // the engine ignore `defaultDays` entirely. Accepting a number here
  // would store a value that never applies, which reads back as a real
  // setting and quietly contradicts how payroll behaves.
  const unpaid = requested.filter(
    (r) => !byCode.get(r.code)?.paid && r.days > 0,
  )
  if (unpaid.length > 0) {
    return jsonError(
      400,
      `${unpaid
        .map((r) => r.code)
        .join(
          ", ",
        )} is unpaid leave, which has no entitlement — the engine ignores its day count. Send 0 or omit it.`,
    )
  }

  try {
    for (const { code, days } of requested) {
      const type = byCode.get(code)
      if (!type) continue
      if (type.defaultDays === days) continue
      await leaveRepository.updateType(orgId, type.id, { defaultDays: days })
    }
  } catch (error) {
    return jsonError(
      500,
      safeErrorMessage(error, "Could not update leave entitlements."),
    )
  }

  await bustOrgConfigCaches({ organizationId: orgId })

  const refreshed = await leaveRepository.listTypes(orgId)
  return NextResponse.json({
    data: refreshed.map(toExternalLeaveType),
    total: refreshed.length,
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

function toExternalLeaveType(t: {
  id: string
  code: string
  name: string
  paid: boolean
  accrualMethod: string
  prorateFirstYear: boolean
  defaultDays: number
  carryForward: boolean
  carryExpiryMonth: number | null
  maxCarryForwardDays: number | null
}) {
  return {
    id: t.id,
    /// Stable identifier to PATCH against.
    code: t.code,
    name: t.name,
    /// The org-wide default — the ONLY writable field here.
    defaultDays: t.defaultDays,
    /// Everything below is read-only: configured by CS in the admin UI.
    /// Returned so a partner form can display the client's real terms
    /// rather than implying the day count is the whole story.
    paid: t.paid,
    accrualMethod: t.accrualMethod,
    prorateFirstYear: t.prorateFirstYear,
    carryForward: t.carryForward,
    carryExpiryMonth: t.carryExpiryMonth,
    maxCarryForwardDays: t.maxCarryForwardDays,
    /// True when a policy or per-employee override can outrank
    /// `defaultDays` for some staff. Always possible in principle — this
    /// flags that day counts here are a fallback, not a guarantee.
    overridable: true,
  }
}
