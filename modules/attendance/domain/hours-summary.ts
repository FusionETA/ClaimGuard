export type HoursBuckets = {
  normalMin: number
  otMin: number
  restDayMin: number
  publicHolidayMin: number
  totalMin: number
  /// Status sub-totals of the OT-eligible minutes (which is
  /// `otMin + restDayMin + publicHolidayMin`), split by the underlying
  /// day's OT `ApprovalRequest` status. These are filled in by the
  /// aggregator (the per-record `bucketRecord` itself doesn't know the
  /// approval status — it only categorises by day type and threshold).
  ///
  /// Invariant when every OT day has a matching request:
  ///   otApprovedMin + otPendingMin + otRejectedMin
  ///       === otMin + restDayMin + publicHolidayMin
  /// Days with NO OT request (legacy / never-auto-created) sit in
  /// none of the three sub-totals — the difference accounts for them.
  otApprovedMin: number
  otPendingMin: number
  otRejectedMin: number
}

export const EMPTY_BUCKETS: HoursBuckets = {
  normalMin: 0,
  otMin: 0,
  restDayMin: 0,
  publicHolidayMin: 0,
  totalMin: 0,
  otApprovedMin: 0,
  otPendingMin: 0,
  otRejectedMin: 0,
}

export type BucketInputs = {
  durationMin: number
  date: Date
  isPublicHoliday: boolean
  workingDays: Set<number>
  standardDailyMin: number
  /// Minutes per day that must be exceeded before time counts as OT on a
  /// regular working day. Org-wide setting. Independent from
  /// standardDailyMin (which is per-project working hours used for
  /// display/scheduling).
  otThresholdMin: number
  hasApprovedOT: boolean
}

const DEFAULT_WORKING_DAYS = new Set([1, 2, 3, 4, 5])
const DEFAULT_STANDARD_DAILY_MIN = 8 * 60
export const DEFAULT_OT_THRESHOLD_MIN = 8 * 60

export function parseWorkingDays(csv: string | null | undefined): Set<number> {
  if (!csv) return new Set(DEFAULT_WORKING_DAYS)
  const out = new Set<number>()
  for (const part of csv.split(",")) {
    const n = Number(part.trim())
    if (Number.isInteger(n) && n >= 1 && n <= 7) out.add(n)
  }
  return out.size === 0 ? new Set(DEFAULT_WORKING_DAYS) : out
}

export function isoWeekday(date: Date): number {
  // 1 = Monday … 7 = Sunday (matches workingDays storage)
  const day = date.getUTCDay()
  return day === 0 ? 7 : day
}

export function parseHmToMinutes(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h < 0 || h > 24 || m < 0 || m > 59) return null
  return h * 60 + m
}

export const DEFAULT_LUNCH_BREAK_MIN = 60

export function standardDailyMinutesFrom(
  start: string | null | undefined,
  end: string | null | undefined,
  lunchBreakMin: number | null | undefined = DEFAULT_LUNCH_BREAK_MIN,
): number {
  const startMin = parseHmToMinutes(start)
  const endMin = parseHmToMinutes(end)
  if (startMin === null || endMin === null || endMin <= startMin) {
    return DEFAULT_STANDARD_DAILY_MIN
  }
  const lunch =
    typeof lunchBreakMin === "number" && Number.isFinite(lunchBreakMin)
      ? Math.max(0, Math.floor(lunchBreakMin))
      : DEFAULT_LUNCH_BREAK_MIN
  return Math.max(0, endMin - startMin - lunch)
}

/// Compute the expected (minimum) working minutes for an inclusive
/// [from, to] UTC date range. Counts each calendar day whose ISO
/// weekday is in `workingDays` and multiplies by `standardDailyMin`.
/// Off-days (rest days, public holidays, leave) are intentionally NOT
/// subtracted — this is a pure "scheduled days × daily hours" target.
export function expectedMinutesForRange(input: {
  from: Date
  to: Date
  workingDays: Set<number>
  standardDailyMin: number
}): number {
  const { from, to, workingDays, standardDailyMin } = input
  if (standardDailyMin <= 0) return 0
  // Normalize to UTC midnight so we iterate full calendar days
  const start = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  )
  const end = new Date(
    Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()),
  )
  if (end < start) return 0
  let days = 0
  const cursor = new Date(start)
  while (cursor <= end) {
    if (workingDays.has(isoWeekday(cursor))) days += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days * standardDailyMin
}

/// Format an "actual / expected" pair like "26h / 40h". The actual
/// number keeps minute granularity ("26h 30m") while the expected
/// drops minutes when the remainder is zero for a cleaner target.
export function formatHoursOfTarget(actualMin: number, expectedMin: number): string {
  const safeActual = Math.max(0, Math.round(actualMin))
  const safeExpected = Math.max(0, Math.round(expectedMin))
  const actualH = Math.floor(safeActual / 60)
  const actualM = safeActual % 60
  const actualStr = actualM === 0 ? `${actualH}h` : `${actualH}h ${actualM.toString().padStart(2, "0")}m`
  const expectedH = Math.floor(safeExpected / 60)
  const expectedM = safeExpected % 60
  const expectedStr =
    expectedM === 0
      ? `${expectedH}h`
      : `${expectedH}h ${expectedM.toString().padStart(2, "0")}m`
  return `${actualStr} / ${expectedStr}`
}

export function bucketRecord(input: BucketInputs): HoursBuckets {
  const dur = Math.max(0, input.durationMin)
  if (dur === 0) return { ...EMPTY_BUCKETS }

  if (input.isPublicHoliday) {
    return {
      normalMin: 0,
      otMin: 0,
      restDayMin: 0,
      publicHolidayMin: dur,
      totalMin: dur,
      otApprovedMin: 0,
      otPendingMin: 0,
      otRejectedMin: 0,
    }
  }

  const weekday = isoWeekday(input.date)
  if (!input.workingDays.has(weekday)) {
    return {
      normalMin: 0,
      otMin: 0,
      restDayMin: dur,
      publicHolidayMin: 0,
      totalMin: dur,
      otApprovedMin: 0,
      otPendingMin: 0,
      otRejectedMin: 0,
    }
  }

  const threshold = Math.max(0, input.otThresholdMin)
  if (dur <= threshold) {
    return {
      normalMin: dur,
      otMin: 0,
      restDayMin: 0,
      publicHolidayMin: 0,
      totalMin: dur,
      otApprovedMin: 0,
      otPendingMin: 0,
      otRejectedMin: 0,
    }
  }

  // Always cap "normal" at the threshold — anything beyond is OT, even if
  // the OT request is still PENDING or has been REJECTED. Approval status
  // is the payroll gate (only APPROVED OT contributes to OT pay), not a
  // display-time bucket gate. Without this cap, an over-threshold day
  // would silently inflate normal hours and underreport OT in the admin's
  // hours summary.
  //
  // `hasApprovedOT` is kept on the input shape for backwards-compatibility
  // with existing callers but is intentionally not consulted here.
  return {
    normalMin: threshold,
    otMin: dur - threshold,
    restDayMin: 0,
    publicHolidayMin: 0,
    totalMin: dur,
    otApprovedMin: 0,
    otPendingMin: 0,
    otRejectedMin: 0,
  }
}

export function addBuckets(a: HoursBuckets, b: HoursBuckets): HoursBuckets {
  return {
    normalMin: a.normalMin + b.normalMin,
    otMin: a.otMin + b.otMin,
    restDayMin: a.restDayMin + b.restDayMin,
    publicHolidayMin: a.publicHolidayMin + b.publicHolidayMin,
    totalMin: a.totalMin + b.totalMin,
    otApprovedMin: a.otApprovedMin + b.otApprovedMin,
    otPendingMin: a.otPendingMin + b.otPendingMin,
    otRejectedMin: a.otRejectedMin + b.otRejectedMin,
  }
}

export function formatHm(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes))
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return `${h}h ${m.toString().padStart(2, "0")}m`
}
