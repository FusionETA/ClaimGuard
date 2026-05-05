export const DEFAULT_TIMEZONE = "Asia/Kuala_Lumpur"

/**
 * Curated list of timezones offered in the admin settings UI. We expose a
 * short list rather than the full IANA database so the dropdown stays
 * scannable. Order: most likely first, then alphabetical by region.
 */
export const TIMEZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "Asia/Kuala_Lumpur", label: "Kuala Lumpur (GMT+8)" },
  { value: "Asia/Singapore", label: "Singapore (GMT+8)" },
  { value: "Asia/Hong_Kong", label: "Hong Kong (GMT+8)" },
  { value: "Asia/Shanghai", label: "Shanghai (GMT+8)" },
  { value: "Asia/Taipei", label: "Taipei (GMT+8)" },
  { value: "Asia/Manila", label: "Manila (GMT+8)" },
  { value: "Asia/Bangkok", label: "Bangkok (GMT+7)" },
  { value: "Asia/Jakarta", label: "Jakarta (GMT+7)" },
  { value: "Asia/Tokyo", label: "Tokyo (GMT+9)" },
  { value: "Asia/Seoul", label: "Seoul (GMT+9)" },
  { value: "Asia/Dubai", label: "Dubai (GMT+4)" },
  { value: "Asia/Kolkata", label: "Kolkata (GMT+5:30)" },
  { value: "Australia/Sydney", label: "Sydney (GMT+10/11)" },
  { value: "Australia/Perth", label: "Perth (GMT+8)" },
  { value: "Pacific/Auckland", label: "Auckland (GMT+12/13)" },
  { value: "Europe/London", label: "London (GMT+0/1)" },
  { value: "Europe/Berlin", label: "Berlin (GMT+1/2)" },
  { value: "America/New_York", label: "New York (GMT-5/-4)" },
  { value: "America/Los_Angeles", label: "Los Angeles (GMT-8/-7)" },
  { value: "UTC", label: "UTC" },
]

export function isValidTimezone(value: string): boolean {
  if (!value) return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: value })
    return true
  } catch {
    return false
  }
}

/**
 * Format the time portion of a Date as 24-hour HH:mm in the given timezone.
 * Used for approval titles ("Clock-in 14:50") so they show local time.
 */
export function formatLocalHm(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(date)
}

/**
 * Build a UTC `Date` representing the given HH:mm on the same local-calendar
 * day as `now` (interpreted in the given timezone). Used to compare a
 * clock-in time against the project's local-time `workingHoursStart`.
 *
 * Note: uses the timezone offset at `now`, so it's accurate around DST
 * transitions for "today's" expected start.
 */
export function expectedTimeOnLocalDay(
  now: Date,
  hhmm: string,
  timezone: string,
): Date {
  const [hh, mm] = hhmm.split(":").map((n) => Number(n))
  const safeHh = Number.isFinite(hh) ? hh : 9
  const safeMm = Number.isFinite(mm) ? mm : 0

  // Get the local Y-M-D in the target timezone
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const get = (t: string) => dateParts.find((p) => p.type === t)?.value ?? "00"
  const localYmd = `${get("year")}-${get("month")}-${get("day")}`

  // Compute the timezone's UTC offset at this instant (in minutes)
  const offsetMin = getTimezoneOffsetMinutes(now, timezone)
  const sign = offsetMin >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMin)
  const offH = String(Math.floor(abs / 60)).padStart(2, "0")
  const offM = String(abs % 60).padStart(2, "0")

  const iso = `${localYmd}T${String(safeHh).padStart(2, "0")}:${String(safeMm).padStart(2, "0")}:00${sign}${offH}:${offM}`
  return new Date(iso)
}

/**
 * Returns the timezone's offset from UTC, in minutes, at the given instant.
 * Positive for east of UTC.
 */
function getTimezoneOffsetMinutes(at: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const parts = dtf.formatToParts(at)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0")
  // Construct the wall-clock time as if it were UTC, then diff with the real instant.
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  )
  return Math.round((asUtc - at.getTime()) / 60000)
}
