import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Org-wide public-holiday calendar (`OrgHoliday`). Split out of
 * `/api/v1/settings` because it's a variable-length list of rows rather
 * than a scalar preference, so it needs list + replace semantics of its
 * own.
 *
 * ## This is a date list, not a holiday rule engine
 *
 * AltomateHR stores holidays as explicit `(date, name)` rows. There is
 * NO state code, no "observe national holidays" flag, and no
 * exclusion-by-name list — so a rule-shaped request like
 * `{ state: "SGR", observeNational: true, excluded: ["Thaipusam"] }`
 * cannot be honoured as-is. Resolve the rule to dates on your side (a
 * state's gazetted list, minus what the company doesn't observe) and
 * PUT the result. That keeps the state/federal holiday policy — which
 * changes yearly and by gazette — in one place instead of half-encoded
 * in our schema.
 *
 * Per-project calendars override this one: see
 * `/api/v1/projects/[id]/holidays` for a site that observes a different
 * set (a Penang branch vs a Selangor HQ).
 *
 * Scope: `settings:read` / `settings:write`, same as the settings
 * resource this hangs off.
 */

const yearSchema = z.coerce.number().int().min(2000).max(2100)

/**
 * GET /api/v1/settings/holidays[?year=YYYY]
 *
 * Required scope: `settings:read`. Omit `year` to get every holiday on
 * record. Ordered by date ascending.
 */
export const GET = handleApiRequest(["settings:read"], async (request, ctx) => {
  const rawYear = new URL(request.url).searchParams.get("year")
  let year: number | null = null
  if (rawYear !== null) {
    const parsedYear = yearSchema.safeParse(rawYear)
    if (!parsedYear.success) {
      return jsonError(400, "`year` must be a 4-digit year between 2000 and 2100.")
    }
    year = parsedYear.data
  }

  const all = await organizationRepository.getOrgHolidays(
    ctx.integration.organizationId,
  )
  const holidays = year === null ? all : all.filter((h) => inYear(h.date, year))

  return NextResponse.json({
    data: holidays,
    total: holidays.length,
    year,
  })
})

const replaceHolidaysSchema = z
  .object({
    /// The year being replaced. Required, and every date must fall
    /// inside it — a PUT can never touch another year, so sending 2027
    /// can't silently wipe the 2026 calendar mid-payroll-year.
    year: z.number().int().min(2000).max(2100),
    /// The complete list for that year. An empty array clears the year.
    /// Dates are ISO `YYYY-MM-DD`; duplicates are rejected rather than
    /// silently collapsed, so a mis-keyed date surfaces instead of
    /// quietly dropping a holiday.
    holidays: z
      .array(
        z
          .object({
            date: z
              .string()
              .trim()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD."),
            name: z.string().trim().min(1).max(120),
          })
          .strict(),
      )
      .max(60),
  })
  .strict()

/**
 * PUT /api/v1/settings/holidays
 *
 * Required scope: `settings:write`. Full replace of one year's
 * calendar: dates you send are upserted, dates we hold for that year
 * that you DIDN'T send are deleted. Other years are untouched.
 *
 * Replace rather than append because that's what a setup form needs —
 * re-submitting after the client unticks a holiday has to remove it,
 * and an append-only endpoint would leave the removed row behind.
 */
export const PUT = handleApiRequest(["settings:write"], async (request, ctx) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, "Invalid JSON body.")
  }

  const parsed = replaceHolidaysSchema.safeParse(body)
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

  const { year, holidays } = parsed.data
  const orgId = ctx.integration.organizationId

  const outOfRange = holidays.filter((h) => !inYear(h.date, year))
  if (outOfRange.length > 0) {
    return jsonError(
      400,
      `Every date must fall in ${year}. Out of range: ${outOfRange
        .map((h) => h.date)
        .join(", ")}.`,
    )
  }

  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const h of holidays) {
    if (seen.has(h.date)) duplicates.add(h.date)
    seen.add(h.date)
  }
  if (duplicates.size > 0) {
    return jsonError(
      400,
      `Duplicate dates in payload: ${[...duplicates].join(", ")}.`,
    )
  }

  // Reject an obviously-invalid calendar date that still matches the
  // regex (e.g. 2026-02-30). `new Date` would roll it forward to
  // March 2, so we'd store a date the caller never sent.
  const invalid = holidays.filter((h) => !isRealDate(h.date))
  if (invalid.length > 0) {
    return jsonError(
      400,
      `Not real calendar dates: ${invalid.map((h) => h.date).join(", ")}.`,
    )
  }

  try {
    const existing = (await organizationRepository.getOrgHolidays(orgId)).filter(
      (h) => inYear(h.date, year),
    )

    // Upsert first, then prune. Doing it in this order means a failure
    // partway through leaves a superset of the intended calendar rather
    // than a gap — an extra holiday is a visible wrong answer, a
    // missing one silently turns a rest day into a working day.
    for (const h of holidays) {
      await organizationRepository.upsertOrgHoliday({
        organizationId: orgId,
        date: toUtcDate(h.date),
        name: h.name,
      })
    }

    for (const stale of existing) {
      if (!seen.has(stale.date)) {
        await organizationRepository.deleteOrgHoliday(stale.id, orgId)
      }
    }
  } catch (error) {
    return jsonError(
      500,
      safeErrorMessage(error, "Could not replace the holiday calendar."),
    )
  }

  await bustOrgConfigCaches({ organizationId: orgId })

  const refreshed = (await organizationRepository.getOrgHolidays(orgId)).filter(
    (h) => inYear(h.date, year),
  )
  return NextResponse.json({
    data: refreshed,
    total: refreshed.length,
    year,
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

function inYear(isoDate: string, year: number): boolean {
  return isoDate.startsWith(`${year}-`)
}

/// `OrgHoliday.date` is a `@db.Date` column and `getOrgHolidays` reads it
/// back with `toISOString().slice(0, 10)`, so we have to write UTC
/// midnight for the round-trip to be lossless.
function toUtcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`)
}

/// True when the string is a date that actually exists — guards against
/// `2026-02-30`, which the regex accepts and `new Date` silently rolls
/// forward.
function isRealDate(isoDate: string): boolean {
  const parsed = toUtcDate(isoDate)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === isoDate
  )
}
