import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Per-project public-holiday calendar (`ProjectHoliday`). The site-level
 * override of `/api/v1/settings/holidays` — for a multi-location org
 * where a Penang branch and a Selangor HQ observe different gazetted
 * days.
 *
 * Same shape and same year-scoped replace semantics as the org endpoint;
 * see its docs for why holidays are an explicit date list here rather
 * than a state-code rule. Resolve the state's list on your side and PUT
 * the dates.
 *
 * Scope: `projects:read` / `projects:write` — this is project
 * configuration, so it follows the projects resource rather than
 * `settings:*`.
 */

type RouteParams = { id: string }

const yearSchema = z.coerce.number().int().min(2000).max(2100)

/**
 * GET /api/v1/projects/[id]/holidays[?year=YYYY]
 *
 * Required scope: `projects:read`. Omit `year` for every holiday on
 * record for this project.
 */
export const GET = handleApiRequest<RouteParams>(
  ["projects:read"],
  async (request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing project id.")

    const rawYear = new URL(request.url).searchParams.get("year")
    let year: number | null = null
    if (rawYear !== null) {
      const parsedYear = yearSchema.safeParse(rawYear)
      if (!parsedYear.success) {
        return jsonError(
          400,
          "`year` must be a 4-digit year between 2000 and 2100.",
        )
      }
      year = parsedYear.data
    }

    const project = await findProject(ctx.integration.organizationId, id)
    if (!project) return jsonError(404, "Project not found.")

    const all = project.holidays ?? []
    const holidays = year === null ? all : all.filter((h) => inYear(h.date, year))

    return NextResponse.json({
      data: holidays,
      total: holidays.length,
      year,
    })
  },
)

const replaceHolidaysSchema = z
  .object({
    /// The year being replaced. Every date must fall inside it, so a PUT
    /// can never reach into another payroll year.
    year: z.number().int().min(2000).max(2100),
    /// The complete list for that year. Empty array clears the year,
    /// which makes the project fall back to nothing — note that project
    /// holidays do NOT inherit the org calendar, so clearing here means
    /// this site observes no holidays at all.
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
 * PUT /api/v1/projects/[id]/holidays
 *
 * Required scope: `projects:write`. Full replace of one year for this
 * project: dates sent are upserted, dates we hold for that year that
 * weren't sent are deleted. Other years untouched.
 */
export const PUT = handleApiRequest<RouteParams>(
  ["projects:write"],
  async (request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing project id.")

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

    const project = await findProject(orgId, id)
    if (!project) return jsonError(404, "Project not found.")

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

    const invalid = holidays.filter((h) => !isRealDate(h.date))
    if (invalid.length > 0) {
      return jsonError(
        400,
        `Not real calendar dates: ${invalid.map((h) => h.date).join(", ")}.`,
      )
    }

    try {
      const existing = (project.holidays ?? []).filter((h) =>
        inYear(h.date, year),
      )

      // Upsert before pruning, so a mid-flight failure leaves a superset
      // of the intended calendar rather than a hole — an extra holiday
      // is visibly wrong, a missing one silently becomes a working day.
      for (const h of holidays) {
        await organizationRepository.upsertProjectHoliday({
          projectId: id,
          date: toUtcDate(h.date),
          name: h.name,
        })
      }

      for (const stale of existing) {
        if (!seen.has(stale.date)) {
          await organizationRepository.deleteProjectHolidayInOrg(stale.id, orgId)
        }
      }
    } catch (error) {
      return jsonError(
        500,
        safeErrorMessage(error, "Could not replace the holiday calendar."),
      )
    }

    await bustOrgConfigCaches({ organizationId: orgId })

    const refreshedProject = await findProject(orgId, id)
    const refreshed = (refreshedProject?.holidays ?? []).filter((h) =>
      inYear(h.date, year),
    )
    return NextResponse.json({
      data: refreshed,
      total: refreshed.length,
      year,
    })
  },
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

/// Scoped lookup — `getProjectsForOrganization` already includes the
/// holiday rows, and going through it means a project in another org is
/// indistinguishable from one that doesn't exist (404, never 403).
async function findProject(organizationId: string, projectId: string) {
  const all =
    await organizationRepository.getProjectsForOrganization(organizationId)
  return all.find((p) => p.id === projectId) ?? null
}

function inYear(isoDate: string, year: number): boolean {
  return isoDate.startsWith(`${year}-`)
}

/// `ProjectHoliday.date` is `@db.Date` and reads back via
/// `toISOString().slice(0, 10)`, so writes must be UTC midnight to
/// round-trip losslessly.
function toUtcDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`)
}

/// Guards `2026-02-30`, which the regex accepts and `new Date` rolls
/// forward to March.
function isRealDate(isoDate: string): boolean {
  const parsed = toUtcDate(isoDate)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === isoDate
  )
}
