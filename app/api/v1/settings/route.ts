import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import {
  invertWeekdayNames,
  isoDaysToWeekdayNames,
  weekdayNames,
  weekdayNamesToCsv,
} from "@/lib/weekdays"
import {
  mileageUnits,
  type OrganizationSummary,
} from "@/modules/organization/domain/models"
import { parseWorkingDays } from "@/modules/attendance/domain/hours-summary"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Single endpoint for org-wide settings — projects/teams/COA all live
 * under their own resources, but the bag of "Organization-level
 * preferences" (name, claim cutoff, working days, currencies, mileage
 * defaults) collapses naturally into one shared GET/PATCH surface.
 *
 * Public holidays are the one org-wide setting that DOESN'T fit here:
 * they're a variable-length list of rows rather than a scalar, so they
 * live at `/api/v1/settings/holidays`.
 *
 * What's NOT here yet:
 *   - geofenceRadiusMeters (no dedicated repo method exists)
 *   - otEnabled (no dedicated repo method)
 *   - working hours (org has defaults, but the values the engines
 *     actually read come from the project — see /api/v1/projects/[id])
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
  const orgId = ctx.integration.organizationId
  const [org, workingDaysCsv] = await Promise.all([
    organizationRepository.getOrganizationById(orgId),
    organizationRepository.getOrgWorkingDays(orgId),
  ])
  if (!org) {
    return jsonError(404, "Organization not found.")
  }
  return NextResponse.json({
    data: toExternalSettings(org, workingDaysCsv),
  })
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
    /// Org-wide default working week, as day names — anything omitted
    /// is a non-working day. A 6-day week is `[…,"SATURDAY"]`.
    /// Stored as the ISO-weekday CSV the payroll + attendance engines
    /// read (`Organization.workingDays`). Projects override this via
    /// `PATCH /api/v1/projects/[id]`, so send the company default here
    /// and per-site exceptions there.
    ///
    /// At least one day is required: an empty week would make the
    /// proration divisor zero. Pass `nonWorkingDays` instead if that's
    /// the shape you hold — send exactly one of the two.
    workingDays: z.array(z.enum(weekdayNames)).min(1).max(7).optional(),
    /// The complement of `workingDays`, for callers whose setup form
    /// collects rest days. `["SATURDAY","SUNDAY"]` ≡ a Mon–Fri week.
    /// Inverted and stored in the same column — it is NOT a second
    /// setting, so sending both is a 400.
    nonWorkingDays: z.array(z.enum(weekdayNames)).max(6).optional(),
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
 * group (name / claimCutoff / workingDays / currencies / mileage) is a
 * separate repo write under the hood; they all run sequentially in
 * the order they appear here.
 *
 * NOT atomic: there's no surrounding transaction, so a later group
 * failing leaves earlier ones applied. Every group is idempotent, so the
 * fix is to re-send the same body — worth knowing before treating a 409
 * as "nothing changed".
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

  if (
    parsed.data.workingDays !== undefined &&
    parsed.data.nonWorkingDays !== undefined
  ) {
    return jsonError(
      400,
      "Send either `workingDays` or `nonWorkingDays`, not both — they write the same column.",
    )
  }

  if (parsed.data.name !== undefined) {
    // `setOrganizationName` skips the admin-membership check that
    // `updateOrganizationName` does: the token is already scoped to one
    // org, so there's no adminId to check. The unique-name collision
    // still throws, and that's a 409 (the other org's name is not this
    // caller's to take).
    try {
      await organizationRepository.setOrganizationName({
        organizationId: orgId,
        organizationName: parsed.data.name,
      })
    } catch (error) {
      return jsonError(
        409,
        safeErrorMessage(error, "Could not update organization name."),
      )
    }
  }

  const nextWorkingDays =
    parsed.data.workingDays ??
    (parsed.data.nonWorkingDays !== undefined
      ? invertWeekdayNames(parsed.data.nonWorkingDays)
      : undefined)

  if (nextWorkingDays !== undefined) {
    if (nextWorkingDays.length === 0) {
      return jsonError(
        400,
        "`nonWorkingDays` cannot cover all 7 days — the org needs at least one working day.",
      )
    }
    try {
      await organizationRepository.setOrgWorkingDays(
        orgId,
        weekdayNamesToCsv(nextWorkingDays),
      )
    } catch (error) {
      return jsonError(
        409,
        safeErrorMessage(error, "Could not update working days."),
      )
    }
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
        safeErrorMessage(error, "Could not update claim cutoff."),
      )
    }
  }

  if (parsed.data.otRates) {
    return jsonError(
      410,
      "OT rates are no longer org-wide. Configure them on each Employee Policy via `PATCH /api/v1/policies/{id}` (coming soon) or the admin UI: Settings → Policies.",
    )
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
        safeErrorMessage(error, "Could not update currencies."),
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
        safeErrorMessage(error, "Could not update mileage defaults."),
      )
    }
  }

  // Bust admin page-data + per-user form-helper caches for this org so
  // the next read picks up the changed settings.
  await bustOrgConfigCaches({ organizationId: orgId })

  // Refetch + project the post-write state.
  const [refreshed, refreshedWorkingDays] = await Promise.all([
    organizationRepository.getOrganizationById(orgId),
    organizationRepository.getOrgWorkingDays(orgId),
  ])
  return NextResponse.json({
    data: refreshed
      ? toExternalSettings(refreshed, refreshedWorkingDays)
      : null,
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

function toExternalSettings(
  org: OrganizationSummary,
  workingDaysCsv: string | null,
) {
  // `parseWorkingDays` is the same reader the payroll + attendance
  // engines use, including its Mon–Fri fallback for a null column — so
  // what we report here is the week that actually gets applied, not the
  // raw (possibly unset) stored value.
  const workingDays = isoDaysToWeekdayNames(parseWorkingDays(workingDaysCsv))
  return {
    id: org.id,
    name: org.name,
    claimCutoffDay: org.claimCutoffDay,
    otEnabled: org.otEnabled,
    /// Effective working week. `configured: false` means no explicit
    /// value is stored and these are the Mon–Fri defaults — worth
    /// surfacing so a partner UI can tell "the client chose Mon–Fri"
    /// from "nobody has set this yet".
    workingDays,
    nonWorkingDays: invertWeekdayNames(workingDays),
    workingDaysConfigured: workingDaysCsv != null,
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
