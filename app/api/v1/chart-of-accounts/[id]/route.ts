import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { toNumber } from "@/lib/decimal"
import {
  limitPeriods,
  limitScopes,
  type ChartOfAccountOption,
} from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Per-account CRUD. PATCH/DELETE only work on CUSTOM accounts —
 * Xero-imported accounts surface a 409 because they're managed in Xero.
 *
 * The /limits sub-endpoint is rolled into PATCH for now (limit fields
 * are passed alongside code/name/etc.). Splitting it into a dedicated
 * sub-route is easy if the partner ever wants finer-grained scoping.
 */

type RouteParams = { id: string }

export const GET = handleApiRequest<RouteParams>(
  ["chart-of-accounts:read"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing account id.")

    const all =
      await organizationRepository.getSelectableChartAccountsForOrganization(
        ctx.integration.organizationId,
      )
    const account = all.find((a) => a.id === id)
    if (!account) {
      return jsonError(404, "Chart account not found.")
    }
    return NextResponse.json({ data: toExternalAccount(account) })
  },
)

const limitInputSchema = z
  .object({
    /// Pass `null` to clear the limit. Pass an object to set/update.
    amount: z.number().nonnegative(),
    period: z.enum(limitPeriods),
    scope: z.enum(limitScopes),
  })
  .nullable()

const updateAccountSchema = z
  .object({
    code: z.string().trim().min(1).max(20).optional(),
    name: z.string().trim().min(2).max(120).optional(),
    type: z.string().trim().max(40).optional(),
    isSelectable: z.boolean().optional(),
    /// `null` clears the limit; object sets it; omitted leaves
    /// untouched.
    limit: limitInputSchema.optional(),
    // NOTE: mileage flags (allowMileageClaim, mileageRate) are NOT
    // patchable through this endpoint yet — the underlying repo only
    // exposes a bulk `setMileageChartAccounts` flow scoped to a Xero
    // connection, not a per-account toggle. When a partner needs them
    // we'll add a dedicated /api/v1/chart-of-accounts/mileage bulk
    // endpoint that wraps that method.
  })
  .strict()

/**
 * PATCH /api/v1/chart-of-accounts/[id]
 *
 * Required scope: `chart-of-accounts:write`. Custom accounts only.
 * Combines two underlying repo methods:
 *   - `updateCustomChartAccount` for code/name/type/isSelectable
 *   - `updateChartAccountLimit` for limit + mileage flags
 *
 * The two are issued sequentially. If the limit update fails after the
 * basic-fields update succeeded, we surface the error but the
 * basic-fields change is already persisted — same behaviour as the
 * admin UI today.
 */
export const PATCH = handleApiRequest<RouteParams>(
  ["chart-of-accounts:write"],
  async (request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing account id.")

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = updateAccountSchema.safeParse(body)
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

    // Existence + custom check up front so we can give 404 / 409 cleanly.
    const all =
      await organizationRepository.getSelectableChartAccountsForOrganization(
        ctx.integration.organizationId,
      )
    const existing = all.find((a) => a.id === id)
    if (!existing) {
      return jsonError(404, "Chart account not found.")
    }
    if (!existing.isCustom) {
      return jsonError(
        409,
        "Xero-imported accounts can't be edited via the API. Edit them in your Xero workspace.",
      )
    }

    // 1) Basic fields (only emit a write if at least one is set, to
    //    avoid wiping `code`/`name` to undefined when only limit fields
    //    were sent).
    if (
      parsed.data.code !== undefined ||
      parsed.data.name !== undefined ||
      parsed.data.type !== undefined ||
      parsed.data.isSelectable !== undefined
    ) {
      try {
        await organizationRepository.updateCustomChartAccount({
          id,
          organizationId: ctx.integration.organizationId,
          code: parsed.data.code ?? existing.code,
          name: parsed.data.name ?? existing.name,
          type: parsed.data.type ?? existing.type,
          isSelectable: parsed.data.isSelectable ?? existing.isSelectable,
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not update account."
        return jsonError(409, message)
      }
    }

    // 2) Limit fields — only when present in the payload. Passing
    //    `limit: null` clears the limit; passing the object sets it.
    //    The repo treats "any field undefined OR amount<=0" as "no
    //    limit", so we either send all-three-fields OR clear via undefined.
    if (parsed.data.limit !== undefined) {
      try {
        await organizationRepository.updateChartAccountLimit({
          chartOfAccountId: id,
          organizationId: ctx.integration.organizationId,
          limitAmount:
            parsed.data.limit === null ? undefined : parsed.data.limit.amount,
          limitPeriod:
            parsed.data.limit === null ? undefined : parsed.data.limit.period,
          limitScope:
            parsed.data.limit === null ? undefined : parsed.data.limit.scope,
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not update limit."
        return jsonError(409, message)
      }
    }

    // Refetch + project so the response reflects the post-write state.
    const refreshed =
      await organizationRepository.getSelectableChartAccountsForOrganization(
        ctx.integration.organizationId,
      )
    const updated = refreshed.find((a) => a.id === id)
    return NextResponse.json({
      data: updated ? toExternalAccount(updated) : null,
    })
  },
)

/**
 * DELETE /api/v1/chart-of-accounts/[id]
 *
 * Required scope: `chart-of-accounts:write`. Custom accounts only — the
 * underlying `deleteCustomChartAccount` repo method has a
 * `where: { isCustom: true }` clause that silently no-ops on
 * Xero-imported rows. We surface that as 409.
 */
export const DELETE = handleApiRequest<RouteParams>(
  ["chart-of-accounts:write"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing account id.")

    const all =
      await organizationRepository.getSelectableChartAccountsForOrganization(
        ctx.integration.organizationId,
      )
    const account = all.find((a) => a.id === id)
    if (!account) {
      return jsonError(404, "Chart account not found.")
    }
    if (!account.isCustom) {
      return jsonError(
        409,
        "Xero-imported accounts can't be deleted via the API.",
      )
    }

    await organizationRepository.deleteCustomChartAccount({
      id,
      organizationId: ctx.integration.organizationId,
    })
    return NextResponse.json({ ok: true })
  },
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

function toExternalAccount(a: ChartOfAccountOption) {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type ?? null,
    status: a.status ?? null,
    isCustom: a.isCustom,
    isSelectable: a.isSelectable,
    isBankAccount: a.isBankAccount,
    isDisabled: a.isDisabled,
    xeroConnectionId: a.xeroConnectionId ?? null,
    limit:
      a.limitAmount === undefined
        ? null
        : {
            amount: toNumber(a.limitAmount, 0),
            period: a.limitPeriod ?? null,
            scope: a.limitScope ?? null,
          },
    mileage: {
      allowMileageClaim: a.allowMileageClaim,
      mileageRate: a.mileageRate === undefined ? null : toNumber(a.mileageRate, 0),
    },
  }
}
