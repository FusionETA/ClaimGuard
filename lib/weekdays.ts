/**
 * Weekday-name ↔ ISO-weekday-CSV conversion.
 *
 * `Organization.workingDays`, `XeroProject.workingDays` and
 * `Shift.workingDays` all store working days as a CSV of ISO weekday
 * numbers (`"1,2,3,4,5"`, Mon = 1 … Sun = 7). That's compact for the DB
 * but opaque over JSON, so the partner API (`/api/v1/settings`,
 * `/api/v1/projects/[id]`) speaks day names instead and converts here.
 *
 * Pure + client-safe — lives in `lib/` so the admin UI can share it if
 * it ever moves off raw CSV. `parseWorkingDays` in
 * `modules/attendance/domain/hours-summary.ts` stays the canonical
 * CSV → Set<number> reader used by the payroll + attendance engines;
 * this module only handles the name mapping on top of it.
 */

/// Index 0 = Monday, matching ISO weekday 1..7.
export const WEEKDAY_NAMES = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const

export type WeekdayName = (typeof WEEKDAY_NAMES)[number]

/// Zod-friendly tuple form (`z.enum` needs a non-empty tuple).
export const weekdayNames = WEEKDAY_NAMES as unknown as [
  WeekdayName,
  ...WeekdayName[],
]

/**
 * Day names → the CSV the DB columns store. Output is de-duplicated and
 * sorted Mon→Sun so the stored value is stable regardless of the order
 * the caller listed them in.
 */
export function weekdayNamesToCsv(names: readonly WeekdayName[]): string {
  const isoDays = new Set<number>()
  for (const name of names) {
    const index = WEEKDAY_NAMES.indexOf(name)
    if (index >= 0) isoDays.add(index + 1)
  }
  return [...isoDays].sort((a, b) => a - b).join(",")
}

/**
 * ISO weekday numbers → day names, sorted Mon→Sun. Accepts the Set that
 * `parseWorkingDays` returns, so callers get engine-identical semantics
 * (including its Mon–Fri fallback for a null/empty column).
 */
export function isoDaysToWeekdayNames(isoDays: Iterable<number>): WeekdayName[] {
  const out: WeekdayName[] = []
  const seen = new Set<number>()
  for (const day of isoDays) {
    if (!Number.isInteger(day) || day < 1 || day > 7 || seen.has(day)) continue
    seen.add(day)
  }
  for (const day of [...seen].sort((a, b) => a - b)) {
    out.push(WEEKDAY_NAMES[day - 1])
  }
  return out
}

/**
 * The complement of a working-day list — the days the org does NOT
 * work. Altomate's setup form collects `nonWorkingDays`, so this lets
 * the API answer in their vocabulary without storing a second column.
 */
export function invertWeekdayNames(
  names: readonly WeekdayName[],
): WeekdayName[] {
  const held = new Set(names)
  return WEEKDAY_NAMES.filter((name) => !held.has(name))
}
