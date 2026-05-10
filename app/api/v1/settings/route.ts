import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import {
  mileageUnits,
  type OrganizationSummary,
} from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Single endpoint for org-wide settings — projects/teams/COA all live
 * under their own resources, but the bag of "Organization-level
 * preferences" (name, claim cutoff, OT rates, currencies, mileage
 * defaults) collapses naturally into one shared GET/PATCH surface.
 *
 * What's NOT here yet:
 *   - geofenceRadiusMeters (no dedicated repo method exists)
 *   - otEnabled (no dedicated repo method)
 *   - working hours (lives on XeroProject, not Organization)
 *   - public holidays (live on XeroProject)
 *
 * Each is a small repo addition when partners ask. Adding them here as
 * separate optional fields when ready is a one-line schema extension
 * plus a passthrough call.
 */

/**
 * GET /api/v1/settings
 *
 * Required scope: `settings:read`. Returns the OrganizationSummary
 * verbatim — same shape the admin UI consumes.
 */
export const GET = handleApiRequest(["settings:read"], async (_request, ctx) => {
  const org = await organizationRepository.getOrganizationById(
    ctx.integration.organizationId,
  )
  if (!org) {
    return jsonError(404, "Organization not found.")
  }
  return NextResponse.json({ data: toExternalSettings(org) })
})

const otRatesSchema = z.object({
  normalDay: z.number().min(1).max(10),
  restDay: z.number().min(1).max(10),
  publicHoliday: z.number().min(1).max(10),
  restDayInShift: z.number().min(0).max(10),
  publicHolidayInShift: z.number().min(0).max(10),
  salaryThreshold: z.number().nonnegative(),
  dailyThresholdMinutes: z.number().int().min(60).max(720),
})

const updateSettingsSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    claimCutoffDay: z.number().int().min(1).max(31).optional(),
    otRates: otRatesSchema.optional(),
    /// ISO 4217 codes the org accepts. Empty array = none configured.
    /// Pair with `defaultCurrency` so partners always set both
    /// together; the repo treats them as a single tuple.
    currencies: z
      .object({
        allowed: z.array(z.string().trim().length(3)).max(20),
        default: z.string().trim().length(3).nullable(),
      })
      .optional(),
    mileage: z
      .object({
        defaultRate: z.number().positive().optional(),
        unit: z.enum(mileageUnits),
      })
      .optional(),
  })
  .strict()

/**
 * PATCH /api/v1/settings
 *
 * Required scope: `settings:write`. Pass any subset of fields. Each
 * group (name / claimCutoff / otRates / currencies / mileage) is a
 * separate repo write under the hood; they all run sequentially in
 * the order they appear here.
 */
export const PATCH = handleApiRequest(["settings:write"], async (request, ctx) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, "Invalid JSON body.")
  }

  const parsed = updateSettingsSchema.safeParse(body)
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

  // Confirm the org actually exists. `updateOrganizationName` requires
  // an adminId parameter for its permission check, which we don't have
  // in API context — so we skip that helper and use a direct
  // prisma.organization.update via a thin passthrough below would be
  // cleaner, but the repo doesn't have such a method. For now, skip
  // name updates from the API surface and document it.
  if (parsed.data.name !== undefined) {
    return jsonError(
      501,
      "Updating organization name through the API is not implemented yet — use the Workpulse admin UI for now.",
    )
  }

  if (parsed.data.claimCutoffDay !== undefined) {
    try {
      await organizationRepository.updateOrganizationClaimCutoff({
        organizationId: orgId,
        claimCutoffDay: parsed.data.claimCutoffDay,
      })
    } catch (error) {
      return jsonError(
        409,
        error instanceof Error ? error.message : "Could not update claim cutoff.",
      )
    }
  }

  if (parsed.data.otRates) {
    try {
      await organizationRepository.updateOrganizationOtRates({
        organizationId: orgId,
        rates: parsed.data.otRates,
      })
    } catch (error) {
      return jsonError(
        409,
        error instanceof Error ? error.message : "Could not update OT rates.",
      )
    }
  }

  if (parsed.data.currencies) {
    // Sanity check: defaultCurrency must be one of the allowed codes
    // (when both are present). Pre-empts the repo's silent acceptance
    // of an inconsistent pair.
    const { allowed, default: defaultCurrency } = parsed.data.currencies
    if (
      defaultCurrency &&
      allowed.length > 0 &&
      !allowed.includes(defaultCurrency)
    ) {
      return jsonError(
        400,
        "defaultCurrency must be present in the allowed list.",
      )
    }
    try {
      await organizationRepository.updateOrganizationCurrencies({
        organizationId: orgId,
        allowedCurrencies: allowed,
        defaultCurrency: defaultCurrency ?? null,
      })
    } catch (error) {
      return jsonError(
        409,
        error instanceof Error ? error.message : "Could not update currencies.",
      )
    }
  }

  if (parsed.data.mileage) {
    try {
      await organizationRepository.updateOrganizationMileageDefaults({
        organizationId: orgId,
        defaultMileageRate: parsed.data.mileage.defaultRate,
        mileageUnit: parsed.data.mileage.unit,
      })
    } catch (error) {
      return jsonError(
        409,
        error instanceof Error ? error.message : "Could not update mileage defaults.",
      )
    }
  }

  // Bust admin page-data + per-user form-helper caches for this org so
  // the next read picks up the changed settings.
  await bustOrgConfigCaches({ organizationId: orgId })

  // Refetch + project the post-write state.
  const refreshed = await organizationRepository.getOrganizationById(orgId)
  return NextResponse.json({
    data: refreshed ? toExternalSettings(refreshed) : null,
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

function toExternalSettings(org: OrganizationSummary) {
  return {
    id: org.id,
    name: org.name,
    claimCutoffDay: org.claimCutoffDay,
    otEnabled: org.otEnabled,
    otRates: org.otRates,
    currencies: {
      allowed: org.allowedCurrencies,
      default: org.defaultCurrency ?? null,
    },
    mileage: {
      defaultRate: org.defaultMileageRate ?? null,
      unit: org.mileageUnit,
    },
    geofenceRadiusMeters: org.geofenceRadiusMeters,
  }
}
