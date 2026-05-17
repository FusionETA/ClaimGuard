import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { toNumber } from "@/lib/decimal"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Chart of accounts collection. Includes both Xero-imported accounts
 * (read-only via API — managed in Xero) AND custom partner-created
 * accounts. POST always creates a custom account (`isCustom: true`).
 */

/**
 * GET /api/v1/chart-of-accounts
 *
 * Required scope: `chart-of-accounts:read`. Filters: `?onlyCustom=true`
 * for partner-created only, `?selectableOnly=true` to hide accounts
 * marked unselectable (the admin's "selectable" toggle in the UI).
 */
export const GET = handleApiRequest(
  ["chart-of-accounts:read"],
  async (request, ctx) => {
    const url = new URL(request.url)
    const onlyCustom = url.searchParams.get("onlyCustom") === "true"
    const selectableOnly = url.searchParams.get("selectableOnly") === "true"

    const accounts = onlyCustom
      ? await organizationRepository.getCustomChartAccountsForOrganization(
          ctx.integration.organizationId,
        )
      : await organizationRepository.getSelectableChartAccountsForOrganization(
          ctx.integration.organizationId,
        )

    const filtered = selectableOnly
      ? accounts.filter((a) => a.isSelectable)
      : accounts

    return NextResponse.json({
      data: filtered.map(toExternalAccount),
      total: filtered.length,
    })
  },
)

const createAccountSchema = z.object({
  code: z.string().trim().min(1, "Code is required.").max(20),
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
  type: z.string().trim().max(40).optional(),
  /// When false, the account exists but employees can't pick it on
  /// claim submission. Default true (most-common case).
  isSelectable: z.boolean().optional().default(true),
})

/**
 * POST /api/v1/chart-of-accounts
 *
 * Required scope: `chart-of-accounts:write`. Always creates a custom
 * (non-Xero) account. Xero-imported accounts come from the Xero sync.
 */
export const POST = handleApiRequest(
  ["chart-of-accounts:write"],
  async (request, ctx) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = createAccountSchema.safeParse(body)
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

    try {
      const created = await organizationRepository.createCustomChartAccount({
        organizationId: ctx.integration.organizationId,
        code: parsed.data.code.trim(),
        name: parsed.data.name.trim(),
        type: parsed.data.type?.trim(),
        isSelectable: parsed.data.isSelectable ?? true,
      })
      await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })
      return NextResponse.json(
        { data: toExternalAccount(created) },
        { status: 201 },
      )
    } catch (error) {
      const message =
        safeErrorMessage(error, "Could not create account.")
      return jsonError(409, message)
    }
  },
)

// ---------------------------------------------------------------------------
// Helpers (also reused via duplicate in [id]/route.ts)
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
