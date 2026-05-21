import "server-only"

import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"

/// Approved paid-leave minutes for an employee inside [from, to].
/// Used by attendance to reduce expected working minutes.
///
/// MORNING / AFTERNOON count as half a day; full-day spans count working
/// days only (the totalDays we stored already excludes weekends per the
/// org working-days rule). For multi-day applications that straddle the
/// requested window, we approximate proportionally — totalDays * (overlap
/// days / span days) — which is exact when the application's working-days
/// distribution is uniform across the span.
///
/// Unpaid leave is intentionally excluded.
export async function paidLeaveMinutes(
  employeeProfileId: string,
  from: Date,
  to: Date,
  dailyMin: number,
): Promise<number> {
  if (dailyMin <= 0) return 0
  const apps = await leaveRepository.listApprovedPaidApplicationsInRange(
    employeeProfileId,
    from,
    to,
  )
  let totalDays = 0
  for (const a of apps) {
    const aStart = utcMidnight(a.startDate)
    const aEnd = utcMidnight(a.endDate)
    const wStart = utcMidnight(from)
    const wEnd = utcMidnight(to)
    const overlapStart = aStart > wStart ? aStart : wStart
    const overlapEnd = aEnd < wEnd ? aEnd : wEnd
    if (overlapEnd < overlapStart) continue
    const spanDays = dayDiff(aStart, aEnd) + 1
    const overlapDays = dayDiff(overlapStart, overlapEnd) + 1
    const portion = spanDays === 0 ? 0 : overlapDays / spanDays
    totalDays += a.totalDays * portion
  }
  return Math.round(totalDays * dailyMin)
}

export async function employeeProfileIdForUserId(userId: string): Promise<string | null> {
  return leaveRepository.findEmployeeProfileIdByUserId(userId)
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function dayDiff(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000))
}
