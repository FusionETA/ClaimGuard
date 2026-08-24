import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { auditLogRepository } from "@/modules/audit/infrastructure/audit-log.repository"

/**
 * GET /api/v1/audit — the organisation's activity log.
 *
 * Answers "who changed the OT rate last month", "what did CS touch on
 * this org", "when was this employee's policy reassigned". Every row
 * carries the actor (email + name + role), so it is the one place that
 * says who did what.
 *
 * Note `partnerInitiated`: true means the action came through this API
 * rather than a human in the admin UI. Worth surfacing — for those rows
 * the actor is who the caller NAMED, not who the system authenticated.
 *
 * Query params:
 *   - limit   (1..200, default 50)
 *   - cursor  (id from the previous page's `nextCursor`)
 *   - action  (prefix match, e.g. "claim" or "claim.approve")
 *   - status  (SUCCESS | FAILED)
 *   - actorUserId
 *   - from / to (ISO dates; `to` is exclusive)
 *
 * Scope: `settings:read`. Deliberately reuses the settings scope rather
 * than introducing `audit:read` — a NEW scope is absent from every
 * already-issued token's stored `scopes` array, so it would 403 for
 * every existing integration until each token was re-issued. Adding a
 * scope is a breaking change for existing callers even though it looks
 * additive.
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).optional(),
  /// Matches `AuditStatus` — the stored value is FAILED, not FAILURE.
  status: z.enum(["SUCCESS", "FAILED"]).optional(),
  actorUserId: z.string().trim().min(1).optional(),
  from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export const GET = handleApiRequest(["settings:read"], async (request, ctx) => {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  )
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
  const q = parsed.data

  const { entries, nextCursor } = await auditLogRepository.listForOrganization(
    ctx.integration.organizationId,
    {
      limit: q.limit ?? 50,
      cursor: q.cursor,
      actionPrefix: q.action,
      status: q.status,
      actorUserId: q.actorUserId,
      fromIso: q.from,
      toIso: q.to,
    },
  )

  return NextResponse.json({ data: entries, nextCursor })
})
