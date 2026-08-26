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

/// One day's worth of shipped features, produced by
/// `groupShippedByDate`. The sheet renders each group under a single
/// date header so the viewer reads "what changed on this date" at a
/// glance instead of a flat list with the date repeated on every card.
export type ShippedDateGroup = {
  /// "YYYY-MM-DD" — the shared ship date for every item in `items`.
  date: string
  items: ShippedFeature[]
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
    id: "ship-v1-api-read-endpoints-2026-08-24",
    date: "2026-08-24",
    title: "Connected apps can now read leave, payroll and org activity",
    body:
      "Integrations built on the AltomateHR API can pull a lot more without " +
      "anyone exporting a spreadsheet: one combined count of everything " +
      "waiting on approval, leave applications and per-employee balances, " +
      "salary history, worked-hours summaries, a payroll run's pre-submit " +
      "readiness checks, the payroll item dictionary, your audit log, and " +
      "staff loans with their repayment schedules.",
    audience: "ADMIN",
  },
  {
    id: "ship-employee-password-reset-2026-07-20",
    date: "2026-07-20",
    title: "Reset an employee's password back to the default",
    body:
      "When someone has left or can't get into their account, you can now " +
      "reset their password from the Personal tab of their employee page. " +
      "The new password is shown once with a copy button, and every reset " +
      "is recorded in the audit log.",
    audience: "ADMIN",
  },
  {
    id: "ship-epf-hrdf-employer-numbers-2026-07-20",
    date: "2026-07-20",
    title: "Store your EPF and HRD Corp employer numbers",
    body:
      "Payroll settings now hold your KWSP/EPF and HRD Corp registration " +
      "numbers alongside the LHDN and PERKESO ones, so every statutory " +
      "identity number lives in one place for forms and reports.",
    audience: "ADMIN",
  },
  {
    id: "ship-claims-pdf-export-2026-07-20",
    date: "2026-07-20",
    title: "Export the claims report as a PDF",
    body:
      "The claims breakdown report now has an Export PDF button next to " +
      "Export XLSX, using the same filters. The PDF is a tidy one-row-per-" +
      "claim summary with totals — easy to send to an approver or attach " +
      "to a payment voucher.",
    audience: "ADMIN",
  },
  {
    id: "ship-export-download-feedback-2026-07-20",
    date: "2026-07-20",
    title: "Clearer feedback while a PDF export downloads",
    body:
      "The export dialog now stays open and shows a “Downloading…” spinner " +
      "until the file is ready, instead of closing straight away on a big " +
      "report. The employee list scrolls properly again, downloads no " +
      "longer flash a blank tab, and failures show an error message.",
    audience: "ADMIN",
  },
  {
    id: "ship-stale-page-reload-fix-2026-07-20",
    date: "2026-07-20",
    title: "No more errors on tabs left open during an update",
    body:
      "If you had the app open while we released an update, buttons could " +
      "fail with an unexpected error until you refreshed. Open tabs now " +
      "pick up the new version by themselves.",
    audience: "ALL",
  },
  {
    id: "ship-bulk-export-zip-2026-07-20",
    date: "2026-07-20",
    title: "Bulk exports now give one file per employee",
    body:
      "Exporting attendance reports, leave summaries, or PCB calculation " +
      "details for several employees now downloads a ZIP with a separate " +
      "PDF per person, named after them — so you can forward one " +
      "employee's report without splitting a combined file first.",
    audience: "ADMIN",
  },
  {
    id: "ship-attendance-speed-freshness-2026-07-20",
    date: "2026-07-20",
    title: "Faster Attendance tab, and figures that stay current",
    body:
      "The Attendance admin tab loads noticeably quicker, and leave " +
      "balances load faster too. Changes to working hours, timezone, or " +
      "geofence now show up immediately, and automatic clock-outs and " +
      "past-leaver archiving are reflected right away instead of after a " +
      "delay.",
    audience: "ADMIN",
  },
  {
    id: "ship-auth-render-crash-fix-2026-07-15",
    date: "2026-07-15",
    title: "Fixed a crash that stopped some pages from loading",
    body:
      "Resolved an error that could stop certain pages from opening for " +
      "some people right after signing in. Pages now load reliably.",
    audience: "ALL",
  },
  {
    id: "ship-ot-camera-multifile-2026-07-14",
    date: "2026-07-14",
    title: "Overtime: in-app camera and multiple evidence files",
    body:
      "Submitting overtime now opens the in-app camera to snap evidence, " +
      "just like clock-in. Attach several justification files and remove " +
      "any one before submitting. Overtime that overlaps a request you've " +
      "already sent for the same period is now blocked with a clear message.",
    audience: "EMPLOYEE",
  },
  {
    id: "ship-audit-login-events-2026-07-14",
    date: "2026-07-14",
    title: "Sign-ins now recorded in the audit log",
    body:
      "Successful sign-ins are now written to your company's audit log, so " +
      "you can review who logged in and when alongside other activity.",
    audience: "ADMIN",
  },
  {
    id: "ship-employee-transfers-2026-07-13",
    date: "2026-07-13",
    title: "Move an employee between companies — no re-onboarding",
    body:
      "Transfer someone to another company in your group with a quick " +
      "wizard: pick the target company, policy, and effective date. If " +
      "they've worked there before, their existing profile and payroll " +
      "history are reused instead of creating a duplicate record.",
    audience: "ADMIN",
  },
  {
    id: "ship-payroll-run-employee-picker-2026-07-12",
    date: "2026-07-12",
    title: "Pick exactly who's in a payroll run",
    body:
      "The New Draft picker now lets you include or exclude individual " +
      "employees, not just whole policies. Search by name or job title, " +
      "untick anyone who shouldn't be in this month's run, and watch the " +
      "running “X of Y included” count show the net effect.",
    audience: "ADMIN",
  },
  {
    id: "ship-payslip-ot-formula-2026-07-11",
    date: "2026-07-11",
    title: "See how your overtime was worked out on the payslip",
    body:
      "Overtime lines on your payslip now show the full breakdown — hours " +
      "× hourly rate × multiplier — instead of just the final amount.",
    audience: "EMPLOYEE",
  },
  {
    id: "ship-leave-pdf-export-2026-07-09",
    date: "2026-07-09",
    title: "Export leave reports as PDF",
    body:
      "Download leave reports as a PDF, with a dialog to choose exactly " +
      "which employees to include.",
    audience: "ADMIN",
  },
  {
    id: "ship-payroll-adjustment-import-2026-07-08",
    date: "2026-07-08",
    title: "Bulk-import payroll adjustments from a spreadsheet",
    body:
      "Upload an XLSX to set manual adjustments for a whole draft run at " +
      "once (replacing what's already there). Payroll now re-runs " +
      "automatically after you save, clear, or import adjustments, so the " +
      "totals always stay in sync.",
    audience: "ADMIN",
  },
  {
    id: "ship-overtime-tab-2026-07-07",
    date: "2026-07-07",
    title: "New Overtime tab with evidence uploads",
    body:
      "Your overtime submissions now live in their own tab, showing each " +
      "request's status — pending, approved, or rejected. Attach or remove " +
      "supporting evidence files on pending and approved records.",
    audience: "EMPLOYEE",
  },
  {
    id: "ship-clock-in-ip-whitelist-2026-07-07",
    date: "2026-07-07",
    title: "Restrict clock-in to your office network",
    body:
      "Admins can now add a list of allowed IP addresses to a project so " +
      "staff only clock in from trusted networks. A “Use current IP” " +
      "button makes adding your office network a single tap.",
    audience: "ADMIN",
  },
  {
    id: "ship-epf-senior-band-2026-07-07",
    date: "2026-07-07",
    title: "More accurate EPF for older employees",
    body:
      "Refined the KWSP/EPF calculation so Malaysian citizens aged 60 and " +
      "over land on the correct contribution rate, and the employer's EPF " +
      "now follows the same official band table.",
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
 * Collapse a flat, newest-first list of shipped features into one
 * dated block per calendar day. Same-date entries are already
 * consecutive in `RECENTLY_SHIPPED` (the daily changelog routine
 * prepends each day's entries as a contiguous run), so a single linear
 * pass preserves both the across-date and within-date newest-first
 * ordering without re-sorting. The sheet renders one date header per
 * returned group.
 */
export function groupShippedByDate(
  shipped: ShippedFeature[],
): ShippedDateGroup[] {
  const groups: ShippedDateGroup[] = []
  for (const feature of shipped) {
    const current = groups[groups.length - 1]
    if (current && current.date === feature.date) {
      current.items.push(feature)
    } else {
      groups.push({ date: feature.date, items: [feature] })
    }
  }
  return groups
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
