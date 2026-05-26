import { NextRequest, NextResponse } from "next/server"

import { getRedis, key } from "@/lib/redis"
import { notify } from "@/modules/notifications/application/services/notification.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"

/**
 * POST /api/cron/temporary-review-reminder
 *
 * Daily reminder for admins to revisit temporary employees (probation /
 * fixed-term) when their `temporaryReviewDate` arrives. Called by an
 * external cron (cPanel) once a day.
 *
 * An employee is "due" when their review date is on or before
 * `today + LEAD_DAYS` and their assigned policy is temporary. For each
 * due employee we push to every admin in that employee's organisation.
 *
 * De-dup: a (admin, employee, reviewDate) tuple is pushed at most once —
 * a Redis key with a long TTL prevents the daily cron from re-notifying
 * the same admin about the same review. Changing the review date issues
 * a fresh notification (the key includes the date).
 *
 * Auth: header `Authorization: Bearer <CRON_SECRET>`.
 */

const LEAD_DAYS = 7
const DEDUP_TTL_SECONDS = 60 * 60 * 24 * 60 // 60 days

export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured on server" },
      { status: 500 },
    )
  }
  const auth = request.headers.get("authorization") ?? ""
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match || match[1].trim() !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  // Cutoff = end of (today + LEAD_DAYS). Anything with a review date at or
  // before this is "coming up or overdue".
  const cutoff = new Date()
  cutoff.setHours(23, 59, 59, 999)
  cutoff.setDate(cutoff.getDate() + LEAD_DAYS)

  let due: Awaited<
    ReturnType<typeof payrollProfileRepository.findDueTemporaryReviews>
  >
  try {
    due = await payrollProfileRepository.findDueTemporaryReviews(cutoff)
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: "failed to query due temporary reviews",
      details: err instanceof Error ? err.message : String(err),
    })
  }

  if (due.length === 0) {
    return NextResponse.json({ ok: true, dueTotal: 0, pushedCount: 0 })
  }

  const redis = getRedis()
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Cache the admin list per org so we don't re-query for each employee.
  const adminsByOrg = new Map<string, string[]>()
  async function adminsForOrg(orgId: string): Promise<string[]> {
    const cached = adminsByOrg.get(orgId)
    if (cached) return cached
    const admins = await organizationRepository.listAdminsForOrganization(orgId)
    const ids = admins.map((a) => a.id)
    adminsByOrg.set(orgId, ids)
    return ids
  }

  let pushedCount = 0
  let skippedCount = 0

  for (const review of due) {
    const adminIds = await adminsForOrg(review.organizationId)
    const reviewDay = new Date(`${review.reviewDate}T00:00:00`)
    const overdue = reviewDay.getTime() < today.getTime()
    const body = overdue
      ? `${review.employeeName}'s temporary review was due ${review.reviewDate}. Check whether to update their policy.`
      : `${review.employeeName}'s temporary review is due ${review.reviewDate}. Check whether to update their policy.`

    for (const adminId of adminIds) {
      const dedupKey = key(
        "temp-review",
        "reviewer",
        adminId,
        review.userId,
        review.reviewDate,
      )

      if (redis) {
        try {
          const already = await redis.get(dedupKey)
          if (already) {
            skippedCount += 1
            continue
          }
        } catch {
          /* treat as not-yet-pushed */
        }
      }

      try {
        await notify({
          userId: adminId,
          organizationId: review.organizationId,
          type: "TEMPORARY_REVIEW",
          title: "Temporary employee review due",
          body,
          url: `/admin/payroll/employees/${review.userId}`,
        })
      } catch {
        // notify swallows internally; belt + suspenders.
      }

      if (redis) {
        try {
          await redis.set(dedupKey, "1", "EX", DEDUP_TTL_SECONDS)
        } catch {
          /* non-fatal */
        }
      }
      pushedCount += 1
    }
  }

  return NextResponse.json({
    ok: true,
    dueTotal: due.length,
    pushedCount,
    skippedCount,
  })
}
