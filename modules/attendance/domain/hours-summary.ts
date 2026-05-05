export type HoursBuckets = {
  normalMin: number
  otMin: number
  restDayMin: number
  publicHolidayMin: number
  totalMin: number
}

export const EMPTY_BUCKETS: HoursBuckets = {
  normalMin: 0,
  otMin: 0,
  restDayMin: 0,
  publicHolidayMin: 0,
  totalMin: 0,
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

export function standardDailyMinutesFrom(
  start: string | null | undefined,
  end: string | null | undefined,
): number {
  const startMin = parseHmToMinutes(start)
  const endMin = parseHmToMinutes(end)
  if (startMin === null || endMin === null || endMin <= startMin) {
    return DEFAULT_STANDARD_DAILY_MIN
  }
  return endMin - startMin
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
    }
  }

  const threshold = Math.max(0, input.otThresholdMin)
  if (dur <= threshold || !input.hasApprovedOT) {
    return {
      normalMin: dur,
      otMin: 0,
      restDayMin: 0,
      publicHolidayMin: 0,
      totalMin: dur,
    }
  }

  return {
    normalMin: threshold,
    otMin: dur - threshold,
    restDayMin: 0,
    publicHolidayMin: 0,
    totalMin: dur,
  }
}

export function addBuckets(a: HoursBuckets, b: HoursBuckets): HoursBuckets {
  return {
    normalMin: a.normalMin + b.normalMin,
    otMin: a.otMin + b.otMin,
    restDayMin: a.restDayMin + b.restDayMin,
    publicHolidayMin: a.publicHolidayMin + b.publicHolidayMin,
    totalMin: a.totalMin + b.totalMin,
  }
}

export function formatHm(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes))
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return `${h}h ${m.toString().padStart(2, "0")}m`
}
