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
import type { OrganizationProjectOption } from "@/modules/organization/domain/models"
import { parseWorkingDays } from "@/modules/attendance/domain/hours-summary"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Per-project CRUD. Sibling to /api/v1/projects (list + create).
 *
 * DELETE only succeeds for manual (partner-created) projects —
 * Xero-imported projects come from the sync and aren't safe to delete
 * through the API. The `deleteManualProject` repo method enforces that
 * with a `where: { isManual: true }` clause.
 */

type RouteParams = { id: string }

/**
 * GET /api/v1/projects/[id]
 *
 * Required scope: `projects:read`.
 */
export const GET = handleApiRequest<RouteParams>(
  ["projects:read"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing project id.")

    const all = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    const project = all.find((p) => p.id === id)
    if (!project) {
      return jsonError(404, "Project not found.")
    }

    return NextResponse.json({ data: toExternalProject(project) })
  },
)

const hhmm = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM in 24-hour form.")

const updateProjectSchema = z
  .object({
    /// Replace the project's manager set when provided (even as `[]`).
    /// Omitted = leave the existing managers untouched.
    projectManagerIds: z.array(z.string().min(1)).optional(),
    location: z.string().trim().max(200).optional(),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    /// Per-site working calendar. This is the override layer for orgs
    /// whose locations don't share one schedule — a Mon–Sat branch
    /// under a Mon–Fri company. `PATCH /api/v1/settings { workingDays }`
    /// sets the company default; anything null here inherits it.
    ///
    /// Resolution order for working days is project → org → Mon–Fri.
    /// (Shifts add a fourth, narrower layer under the project, managed
    /// in the admin UI rather than over the API.)
    ///
    /// Keys you omit keep their current value — the block is merged, not
    /// replaced, so sending only `workingDays` won't blank the hours.
    calendar: z
      .object({
        workingHoursStart: hhmm.nullable().optional(),
        workingHoursEnd: hhmm.nullable().optional(),
        /// Day names; anything omitted is a non-working day at this
        /// site. `null` clears the override so the site falls back to
        /// the org default.
        workingDays: z
          .array(z.enum(weekdayNames))
          .min(1)
          .max(7)
          .nullable()
          .optional(),
        /// Minutes deducted from (end − start) when computing expected
        /// daily hours. Feeds the monthly→hourly rate conversion, so
        /// it's a payroll input, not just a scheduling one.
        lunchBreakMinutes: z.number().int().min(0).max(240).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

/**
 * PATCH /api/v1/projects/[id]
 *
 * Required scope: `projects:write`. Updates managers, location /
 * coordinates, and the working calendar. Project NAME and holidays are
 * not here: renaming goes through the admin UI (Xero-synced rows take
 * their name from the sync), and holidays are a list resource at
 * `/api/v1/projects/[id]/holidays`.
 */
export const PATCH = handleApiRequest<RouteParams>(
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

    const parsed = updateProjectSchema.safeParse(body)
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

    // Existence check first so we can give a clean 404 instead of letting
    // updateProjectDetails silently no-op on a foreign id.
    const all = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    const current = all.find((p) => p.id === id)
    if (!current) {
      return jsonError(404, "Project not found.")
    }

    try {
      await organizationRepository.updateProjectDetails({
        projectId: id,
        organizationId: ctx.integration.organizationId,
        projectManagerIds: parsed.data.projectManagerIds,
        location: parsed.data.location,
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
      })
    } catch (error) {
      const message =
        safeErrorMessage(error, "Could not update project.")
      return jsonError(409, message)
    }

    if (parsed.data.calendar) {
      const cal = parsed.data.calendar
      // `updateProjectCalendar` writes all three columns unconditionally,
      // so omitted keys have to be back-filled from the current row —
      // otherwise a PATCH that only sets working days would null the
      // working hours.
      try {
        await organizationRepository.updateProjectCalendar(id, {
          workingHoursStart:
            cal.workingHoursStart !== undefined
              ? cal.workingHoursStart
              : (current.workingHoursStart ?? null),
          workingHoursEnd:
            cal.workingHoursEnd !== undefined
              ? cal.workingHoursEnd
              : (current.workingHoursEnd ?? null),
          workingDays:
            cal.workingDays !== undefined
              ? cal.workingDays === null
                ? null
                : weekdayNamesToCsv(cal.workingDays)
              : (current.workingDays ?? null),
          ...(cal.lunchBreakMinutes !== undefined
            ? { lunchBreakMinutes: cal.lunchBreakMinutes }
            : {}),
        })
      } catch (error) {
        return jsonError(
          409,
          safeErrorMessage(error, "Could not update the project calendar."),
        )
      }
    }

    await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

    const refreshed = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    const updated = refreshed.find((p) => p.id === id)
    return NextResponse.json({
      data: updated ? toExternalProject(updated) : null,
    })
  },
)

/**
 * DELETE /api/v1/projects/[id]
 *
 * Required scope: `projects:write`. Hard-deletes a MANUAL project.
 * Xero-imported projects refuse to delete (the underlying repo's
 * `where: { isManual: true }` clause silently no-ops), and we surface
 * that as 404. Same goes for foreign-org ids.
 */
export const DELETE = handleApiRequest<RouteParams>(
  ["projects:write"],
  async (_request, ctx) => {
    const { id } = ctx.params
    if (!id) return jsonError(400, "Missing project id.")

    // Confirm first that the project (a) exists in our org, (b) is
    // manual. Anything else gets the same 404 — partner shouldn't be
    // able to distinguish "wrong org" from "Xero-imported".
    const all = await organizationRepository.getProjectsForOrganization(
      ctx.integration.organizationId,
    )
    const project = all.find((p) => p.id === id)
    if (!project) {
      return jsonError(404, "Project not found in this organization.")
    }
    if (!project.isManual) {
      return jsonError(
        409,
        "Xero-imported projects can't be deleted via the API. Manage them from your Xero workspace.",
      )
    }

    await organizationRepository.deleteManualProject({
      projectId: id,
      organizationId: ctx.integration.organizationId,
    })

    await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

    return NextResponse.json({ ok: true })
  },
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

/// Must stay identical to the copy in `../route.ts` — a partner that
/// lists projects then re-reads one must not see a different shape.
function toExternalProject(p: OrganizationProjectOption) {
  const effectiveWorkingDays = isoDaysToWeekdayNames(
    parseWorkingDays(p.workingDays ?? null),
  )
  return {
    id: p.id,
    name: p.name,
    status: p.status ?? null,
    isManual: p.isManual,
    location: p.location ?? null,
    latitude: p.latitude ?? null,
    longitude: p.longitude ?? null,
    /// Raw CSV form, kept for backwards compatibility with callers that
    /// already read it. `calendar` below is the shape to build against.
    workingHoursStart: p.workingHoursStart ?? null,
    workingHoursEnd: p.workingHoursEnd ?? null,
    workingDays: p.workingDays ?? null,
    calendar: {
      workingHoursStart: p.workingHoursStart ?? null,
      workingHoursEnd: p.workingHoursEnd ?? null,
      lunchBreakMinutes: p.lunchBreakMinutes ?? null,
      /// The site's own override, or null when it inherits the org
      /// default. Distinguishing this from `effectiveWorkingDays` lets a
      /// partner UI show "inherited" rather than implying every project
      /// was configured individually.
      workingDays:
        p.workingDays == null
          ? null
          : isoDaysToWeekdayNames(parseWorkingDays(p.workingDays)),
      /// What actually applies at this site once the fallback chain has
      /// run. NOTE: the fallback here is Mon–Fri, the engine default —
      /// it does NOT read the org-level override, so read
      /// `GET /api/v1/settings` alongside this if the project has no
      /// override of its own.
      effectiveWorkingDays,
      nonWorkingDays: invertWeekdayNames(effectiveWorkingDays),
    },
    projectManagers: p.projectManagers,
    holidays: p.holidays ?? [],
  }
}
