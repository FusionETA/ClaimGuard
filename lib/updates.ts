/**
 * Curated changelog data — the only file you edit when you want to
 * tell users about an upcoming maintenance window, a feature in
 * progress, or something that just shipped. Imported by the
 * `<UpdatesAnnouncer>` component mounted in `app/layout.tsx` (renders
 * the top banner + slide-in sheet).
 *
 * Editing workflow:
 *   1. Open this file.
 *   2. Add a new entry to the appropriate array. Put the NEWEST entry
 *      first — the UI assumes the arrays are sorted newest-to-oldest.
 *   3. Commit + push. The droplet deploy webhook picks it up; users
 *      see the change on next page load.
 *
 * No DB column, no admin UI — kept in the repo for V1 so changes are
 * code-reviewable and version-controlled. If we hit a point where
 * we're updating this multiple times a week without a code change,
 * promote to a `AppUpdate` table.
 *
 * Date format hints:
 *   - `MaintenanceWindow.startsAt` / `endsAt`: ISO 8601 WITH timezone
 *     suffix, e.g. "2026-07-12T02:00:00+08:00". The banner's "within
 *     24 hours" check uses these as `Date.parse()` inputs.
 *   - `ShippedFeature.date`: plain "YYYY-MM-DD". No clock time needed.
 *   - `UpcomingFeature.eta`: free-form string ("Mid-July 2026", "Q3").
 *     Goal is to set expectations, not commit to a wall-clock minute.
 */

/// Audience filter for every update entry. The viewer's role is
/// mapped to one of these values at layout time and passed into the
/// component, which then renders only matching rows.
///
///   - `ALL`      — visible to everyone (default when omitted). Use
///                  for scheduled maintenance (downtime affects both
///                  sides) and for cross-cutting features.
///   - `ADMIN`    — visible only to ADMIN / OWNER. Use for admin-side
///                  features (Xero changes, payroll engine, settings).
///   - `EMPLOYEE` — visible only to EMPLOYEE / SUPERVISOR (they share
///                  the /employee/* surfaces). Use for employee-portal
///                  features (claim form, leave apply, payslips).
export type UpdateAudience = "ALL" | "ADMIN" | "EMPLOYEE"

/// One scheduled maintenance window. The banner auto-shows the
/// soonest entry within `BANNER_LEAD_HOURS` of `now()` (see helper
/// below). Past windows can stay in the array for historical display
/// in the sheet — they just won't trigger the banner.
export type MaintenanceWindow = {
  /// Stable id used as a React key + as the sessionStorage dismiss
  /// key. Bump this id when the window CHANGES so a previously-
  /// dismissed banner reappears (admins moved the window forward,
  /// users need to see the new time).
  id: string
  /// ISO 8601 with explicit timezone suffix, e.g. "2026-07-12T02:00:00+08:00".
  startsAt: string
  endsAt: string
  /// One-line label, ≤ ~60 chars (mobile friendly).
  title: string
  /// Plain-text body, 1–3 sentences. Shown in the sheet, not the banner.
  body: string
  /// Who sees this entry. Defaults to `ALL` — downtime affects every
  /// role so most maintenance windows want this. Use `ADMIN` /
  /// `EMPLOYEE` to scope a partial outage (e.g. payroll-only or
  /// claims-only deploy).
  audience?: UpdateAudience
}

export type UpcomingFeature = {
  id: string
  /// Free-form ETA string. Examples: "Mid-July 2026", "Q3 2026", "Next month".
  eta: string
  title: string
  body: string
  /// Who sees this entry. Defaults to `ALL` when omitted. Set to
  /// `ADMIN` or `EMPLOYEE` to scope a teaser to the side that
  /// actually cares about it.
  audience?: UpdateAudience
}

export type ShippedFeature = {
  id: string
  /// "YYYY-MM-DD" — the ship date, not the commit date.
  date: string
  title: string
  body: string
  /// Who sees this entry. Defaults to `ALL` when omitted. Most
  /// shipped features are scoped — a Xero account-sync change goes to
  /// `ADMIN`, a claim-form polish goes to `EMPLOYEE`.
  audience?: UpdateAudience
}

// ─── Edit these arrays when you have news to share ────────────────────

/**
 * Scheduled maintenance windows. Newest first. Past windows are kept
 * for historical context but don't trigger the banner. `audience` is
 * usually omitted (= ALL) because downtime affects everyone.
 *
 * Example entry:
 *   {
 *     id: "maint-2026-07-12",
 *     startsAt: "2026-07-12T02:00:00+08:00",
 *     endsAt:   "2026-07-12T04:00:00+08:00",
 *     title:    "Database upgrade",
 *     body:     "Expected downtime ~10 minutes. The app will be " +
 *               "unreachable while we migrate the database to a new " +
 *               "cluster. All in-flight data is preserved.",
 *     // audience: "ALL" — implied; set "ADMIN" / "EMPLOYEE" for a
 *     // partial-surface outage.
 *   },
 */
export const SCHEDULED_MAINTENANCE: MaintenanceWindow[] = []

/**
 * Features in active development. Use sparingly — only list things
 * you're confident will ship in the next ~6 weeks. Vapourware
 * announcements erode trust. Scope with `audience` so admins don't
 * see employee-facing teasers and vice-versa.
 *
 * Example entries:
 *   {
 *     id: "feat-leave-bulk",
 *     eta: "Mid-July 2026",
 *     title: "Bulk import leave balances",
 *     body: "Upload a CSV to set initial balances for multiple " +
 *           "employees at once — useful when migrating from another " +
 *           "system or correcting a calendar-year reset.",
 *     audience: "ADMIN",
 *   },
 *   {
 *     id: "feat-claim-draft",
 *     eta: "Q3 2026",
 *     title: "Save claim drafts before submitting",
 *     body: "Half-fill a claim, leave, come back later and finish it " +
 *           "without re-uploading the receipt.",
 *     audience: "EMPLOYEE",
 *   },
 */
export const UPCOMING_FEATURES: UpcomingFeature[] = []

/**
 * Recently shipped features. Newest first. Keep ~10 entries — the UI
 * shows the top 3 with a "Show more" toggle for the rest. Beyond 10,
 * trim the tail; old entries belong in git history, not the banner.
 * Always set `audience` so the changelog reads relevant to the viewer.
 *
 * Example entries:
 *   {
 *     id: "ship-pcb-recurring-toggle",
 *     date: "2026-07-04",
 *     title: "“Treat as recurring” PCB toggle",
 *     body: "For employees on monthly commission or director fees — " +
 *           "tick this on a bonus/commission line to flow the amount " +
 *           "through the normal monthly PCB formula instead of LHDN’s " +
 *           "one-shot Additional Remuneration formula. Smooth PCB " +
 *           "instead of a spike.",
 *     audience: "ADMIN",
 *   },
 *   {
 *     id: "ship-claim-edit",
 *     date: "2026-06-10",
 *     title: "Edit a pending claim",
 *     body: "Tap the pencil on a claim row to fix a typo, swap the " +
 *           "receipt, or attach extra supporting documents without " +
 *           "deleting and resubmitting.",
 *     audience: "EMPLOYEE",
 *   },
 */
export const RECENTLY_SHIPPED: ShippedFeature[] = [
  {
    id: "ship-edit-pending-claim-2026-06-10",
    date: "2026-06-10",
    title: "Edit a pending claim",
    body:
      "Tap the pencil on any claim row to fix typos, swap the receipt, " +
      "or attach more supporting documents — without deleting and " +
      "resubmitting.",
    audience: "EMPLOYEE",
  },
  {
    id: "ship-xero-expense-types-2026-06-10",
    date: "2026-06-10",
    title:
      "Chart-of-accounts now includes Direct Costs / Overheads / Depreciation",
    body:
      "Re-sync your Xero connection to pull in account types beyond plain " +
      "EXPENSE.",
    audience: "ADMIN",
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────

/// How far in advance the top banner starts showing a maintenance
/// window. 24h is the standard heads-up — long enough for users to
/// finish urgent work, short enough that the banner doesn't sit on
/// screen for a week before the actual maintenance.
export const BANNER_LEAD_HOURS = 24

/**
 * True when this entry should be visible to a viewer with the given
 * audience tag. Rules:
 *
 *   - Entry omits `audience` (= ALL)  → visible to every viewer.
 *   - Entry sets `ALL`                → visible to every viewer.
 *   - Entry sets `ADMIN` / `EMPLOYEE` → visible only when the viewer
 *                                       matches that tag exactly, OR
 *                                       when the viewer is `ALL`
 *                                       (logged-out / public — shows
 *                                       them everything, since there's
 *                                       no role to scope by).
 *
 * Generic over the entry shape so the same helper filters the three
 * arrays without coupling to a single type.
 */
export function matchesAudience(
  entry: { audience?: UpdateAudience },
  viewer: UpdateAudience,
): boolean {
  const tag = entry.audience ?? "ALL"
  if (tag === "ALL") return true
  if (viewer === "ALL") return true
  return tag === viewer
}

/**
 * The soonest maintenance window whose `startsAt` is within
 * `hoursAhead` from now AND that the given viewer is allowed to see.
 * Returns null when there's nothing imminent — the banner then doesn't
 * render at all. Windows already in progress (startsAt in the past,
 * endsAt in the future) also return so the banner keeps showing until
 * the window closes.
 */
export function getImminentMaintenance(
  viewer: UpdateAudience = "ALL",
  hoursAhead: number = BANNER_LEAD_HOURS,
  now: Date = new Date(),
): MaintenanceWindow | null {
  const nowMs = now.getTime()
  const horizonMs = nowMs + hoursAhead * 60 * 60 * 1000

  // Sort by startsAt ASC so we pick the soonest, even if the array
  // ordering drifts. Belt-and-braces against editor mistakes.
  const sorted = [...SCHEDULED_MAINTENANCE]
    .filter((w) => matchesAudience(w, viewer))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))

  for (const w of sorted) {
    const start = Date.parse(w.startsAt)
    const end = Date.parse(w.endsAt)
    if (Number.isNaN(start) || Number.isNaN(end)) continue
    // Either already in progress (now between start and end), or
    // upcoming within the lead window.
    if (nowMs >= start && nowMs < end) return w
    if (start > nowMs && start <= horizonMs) return w
  }
  return null
}

/**
 * Format a maintenance window range for the banner / sheet. The
 * timezone abbreviation comes from the browser's locale — most
 * Malaysian users will see "MYT" / "+08", but we don't hardcode that
 * (a user in Singapore browsing should see SGT).
 */
export function formatMaintenanceWindow(w: MaintenanceWindow): string {
  const start = new Date(w.startsAt)
  const end = new Date(w.endsAt)
  const dateFmt = new Intl.DateTimeFormat("en-MY", {
    weekday: "short",
    day: "numeric",
    month: "short",
  })
  const timeFmt = new Intl.DateTimeFormat("en-MY", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  })
  // "Sat 12 Jul, 2:00 am – 4:00 am MYT"
  return `${dateFmt.format(start)}, ${timeFmt
    .format(start)
    .replace(/\s+(am|pm)/i, "$1")} – ${timeFmt
    .format(end)
    .replace(/\s+(am|pm)/i, "$1")}`
}

/**
 * Short "Sat 2am" style for the mobile banner where horizontal space
 * is tight. Drops the date when the window is today, drops the year
 * always, drops the timezone (assumed local).
 */
export function formatMaintenanceWindowCompact(
  w: MaintenanceWindow,
  now: Date = new Date(),
): string {
  const start = new Date(w.startsAt)
  const sameDay =
    start.getFullYear() === now.getFullYear() &&
    start.getMonth() === now.getMonth() &&
    start.getDate() === now.getDate()
  const weekday = new Intl.DateTimeFormat("en-MY", { weekday: "short" }).format(
    start,
  )
  const time = new Intl.DateTimeFormat("en-MY", {
    hour: "numeric",
    hour12: true,
  })
    .format(start)
    .replace(/\s+(am|pm)/i, "$1")
  return sameDay ? `Today ${time}` : `${weekday} ${time}`
}
