import "server-only"

import { deleteCacheMany } from "@/lib/cache"
import { key } from "@/lib/redis"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"

/**
 * Auto clock-out sweep (Phase 6).
 *
 * Iterates every AttendanceSession still open (`endedAt IS NULL`) whose
 * employee's policy has `autoClockOutEnabled = true`, computes elapsed
 * net working minutes (wall-clock elapsed minus completed break
 * minutes), and closes any session where that figure meets or exceeds
 * `policy.autoClockOutAfterMin`. Rows on an open break are skipped —
 * they get re-inspected next cycle once the break ends.
 *
 * The recorded `endedAt` is the exact moment the threshold was hit,
 * NOT the moment the cron ran. So a session that hit its threshold at
 * 17:00 but the cron didn't fire until 17:12 still records a 17:00
 * clock-out — the delay in inspection doesn't stretch the duration.
 *
 * Rate-limited to `maxRows` per call (default 200) so a huge backlog
 * can't blow the request budget. Recommended cadence: every 15 min
 * (matches the schema comment on `EmployeePolicy.autoClockOutEnabled`
 * at prisma/schema.prisma:213-215).
 *
 * **Safety notes for the operator**:
 * - Deliberately does NOT create an OT ApprovalRequest even if the
 *   duration exceeds `otDailyThresholdMinutes`. Auto-clockouts are
 *   cleanup for "employee forgot to click Clock Out"; treating that
 *   as auto-OT would flood the queue with phantom requests.
 * - `AttendanceSession.isAutoClockOut = true` is the audit trail. No
 *   AttendanceEditLog row is written (there's no human editor).
 * - Idempotent: a session closed by a prior run no longer matches
 *   the `endedAt IS NULL` filter, so re-running mid-cycle is safe.
 *
 * Trigger via `POST /api/cron/attendance-auto-clockout` with the
 * `CRON_SECRET` bearer token.
 */
export async function runAutoClockOutSweep({
  now,
  maxRows,
}: {
  now?: Date
  maxRows?: number
} = {}): Promise<{
  ok: true
  inspected: number
  clockedOut: number
  errors: number
  runAtIso: string
}> {
  const nowDate = now ?? new Date()
  const cap = maxRows ?? 200

  const candidates =
    await attendanceRepository.listOpenSessionsForAutoClockOut(nowDate, cap)

  let clockedOut = 0
  let errors = 0
  for (const c of candidates) {
    try {
      await attendanceRepository.performAutoClockOut({
        sessionId: c.sessionId,
        recordId: c.recordId,
        cutoffAt: c.cutoffAt,
        durationMin: c.durationMin,
      })
      clockedOut += 1
    } catch (err) {
      errors += 1
      // One bad session can't stop the sweep. Log and keep going;
      // the overall response still returns ok:true and surfaces
      // the failure count for the operator.
      console.error(
        `[attendance-auto-clockout-cron] failed to close session ${c.sessionId}:`,
        err,
      )
    }
  }

  // Closing a session flips the employee's roll-call from
  // CLOCKED_IN → CLOCKED_OUT and updates the per-employee dashboard.
  // We don't track affected orgs cheaply here, so wildcard-bust
  // across all orgs + all users. The cron typically runs every 15
  // min so the extra bust cost is negligible.
  if (clockedOut > 0) {
    await deleteCacheMany([
      key("org", "*", "attendance", "*"),
      key("user", "*", "attendance", "*"),
    ])
  }

  return {
    ok: true,
    inspected: candidates.length,
    clockedOut,
    errors,
    runAtIso: nowDate.toISOString(),
  }
}
