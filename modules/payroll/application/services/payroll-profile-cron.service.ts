import "server-only"

import { deleteCacheMany } from "@/lib/cache"
import { key } from "@/lib/redis"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"

/**
 * Daily sweep: archive every PayrollProfile whose `leaveDate` has
 * already passed but is still marked `isArchived: false`.
 *
 * Complements the two synchronous auto-archive paths:
 *   - `payroll-import.service::autoArchiveFieldsForImport` (79f7fa5)
 *     — fires when an XLSX import row supplies a past leaveDate.
 *   - `upsertPayrollProfile` self-heal on save (417e7e7) — fires
 *     when the admin visits and saves any profile tab.
 *
 * The gap those two miss is the "planned leaver set months in
 * advance" case: admin fills a FUTURE leaveDate, saves (stays
 * active — correct), and time passes. Nobody reopens the profile,
 * so the on-save self-heal never fires. This cron catches it at
 * the next daily run.
 *
 * The payroll RUN engine already excludes past-leaveDate employees
 * from the calc, so this sweep has no financial impact — it's a
 * bookkeeping fix so the Active tab of the Manage Employees list
 * doesn't clutter with departed staff and the yellow "Last working
 * day" banner disappears from stale profiles.
 *
 * **Idempotent:** re-running on the same day is a no-op after the
 * first pass (already-archived profiles no longer match the query).
 *
 * Trigger via `POST /api/cron/payroll-auto-archive-past-leavers`
 * with the `CRON_SECRET` bearer token. Recommended cadence: daily
 * around 00:15 MYT.
 */
export async function runAutoArchivePastLeavers(): Promise<{
  ok: true
  totalFound: number
  archived: number
  errors: number
  runAtIso: string
}> {
  const now = new Date()
  // `today` = start of today in UTC. The check inside the repo is
  // `leaveDate < today`, so a leaveDate of "yesterday or earlier"
  // matches — a leaveDate of today does NOT match (last-day-of-work
  // employees stay active until tomorrow's cron picks them up).
  //
  // Deliberately UTC-anchored rather than local time. All existing
  // leaveDate reads/writes go through toISOString().slice(0,10)
  // which is also UTC — keeping the same reference point avoids a
  // half-day boundary bug where a leaveDate saved as "2026-08-31" in
  // the admin's timezone might read as "2026-08-30" here and get
  // archived a day too early.
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )

  const candidates =
    await payrollProfileRepository.listPastLeaveDateActiveProfiles(today)

  let archived = 0
  let errors = 0
  for (const c of candidates) {
    try {
      await payrollProfileRepository.archive(
        c.employeeProfileId,
        // Preserve the admin's original reason if they set one
        // during the manual Archive click (rare — usually the row
        // gets to this cron BECAUSE admin never clicked Archive).
        // Otherwise stamp a clear cron-authored reason so the
        // audit trail explains why this happened.
        c.archiveReason ?? "Auto-archived (cron): leave date passed",
        c.leaveDate,
      )
      archived += 1
    } catch (err) {
      errors += 1
      // Log per-profile and keep going — one bad row shouldn't stop
      // the sweep. The cron's overall response still returns ok: true
      // as long as the loop finished; the `errors` count surfaces
      // the failed count for the operator to investigate.
      console.error(
        `[payroll-auto-archive-cron] failed to archive profile ${c.employeeProfileId}:`,
        err,
      )
    }
  }

  // Archiving flips the profile out of the Active Manage-Employees
  // list (`org:{orgId}:config:page:manage-employees:*`) and out of the
  // payroll-run rollups (`org:{orgId}:payroll:page:*`). We don't track
  // which orgs the archived profiles belonged to cheaply, so a
  // wildcard bust across all orgs is the pragmatic option — this cron
  // fires once a day.
  if (archived > 0) {
    await deleteCacheMany([
      key("org", "*", "config", "*"),
      key("org", "*", "payroll", "*"),
    ])
  }

  return {
    ok: true,
    totalFound: candidates.length,
    archived,
    errors,
    runAtIso: now.toISOString(),
  }
}
