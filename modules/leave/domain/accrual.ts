import { isoWeekday } from "@/modules/attendance/domain/hours-summary"

import type { LeaveAccrualMethod, LeaveDuration } from "./models"

/// Compute the totalDays for a leave application.
/// - MORNING / AFTERNOON: always 0.5 (caller must enforce startDate==endDate).
/// - FULL_DAY: count of calendar days in [start, end] whose ISO weekday is
///   in `workingDays` (default Mon-Fri).
export function computeTotalDays(
  startDate: Date,
  endDate: Date,
  duration: LeaveDuration,
  workingDays: Set<number>,
): number {
  if (duration !== "FULL_DAY") return 0.5
  const start = utcMidnight(startDate)
  const end = utcMidnight(endDate)
  if (end < start) return 0
  let days = 0
  const cursor = new Date(start)
  while (cursor <= end) {
    if (workingDays.has(isoWeekday(cursor))) days += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

function utcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  )
}

/// Available days an employee can apply for under an entitlement row.
/// PRO_RATED: bound by accrued amount; LUMP_SUM: full entitledDays.
/// Carried days are always available until they expire.
export function availableDaysFor(input: {
  accrualMethod: LeaveAccrualMethod
  entitledDays: number
  accruedDays: number
  carriedDays: number
  carriedExpired: boolean
  usedDays: number
}): number {
  const carry = input.carriedExpired ? 0 : input.carriedDays
  const base = input.accrualMethod === "PRO_RATED" ? input.accruedDays : input.entitledDays
  return Math.max(0, base + carry - input.usedDays)
}

/// One month of accrual for PRO_RATED entitlements. Caps at entitledDays.
export function nextAccruedDays(entitledDays: number, accruedDays: number): number {
  return Math.min(entitledDays, accruedDays + entitledDays / 12)
}

/// Initial `accruedDays` to seed a fresh PRO_RATED entitlement row,
/// based on the employee's join date and what's elapsed in
/// `targetYear` by `now`. Composed of two parts:
///
///   1. Full-month chunks: 1/12 of entitledDays for every calendar
///      month boundary that has been crossed since the employee's
///      "start month" for `targetYear` (Jan if joined in a prior
///      year, else their join month).
///   2. Partial join-month credit: (days worked in join month /
///      days in join month) × 1/12 of entitledDays — only when
///      joinDate falls inside `targetYear`. Otherwise treated as
///      a full Jan (=1/12 chunk).
///
/// Result is capped at entitledDays.
///
/// Pure: caller passes `now` so this is deterministic and
/// unit-testable.
///
/// Examples (entitledDays = 14, targetYear = 2026):
///   - joinDate Feb 11 2026, now Feb 20 2026 →
///       0 full months + 18/28 × (14/12) = 0.75
///   - joinDate Feb 11 2026, now Mar 5 2026 →
///       1 full month (Mar 1 crossed) + 18/28 × (14/12) = 1.92
///   - joinDate Aug 2025, now Apr 4 2026 →
///       Jan was the start month; 3 boundaries crossed (Feb, Mar,
///       Apr) + full Jan chunk = 4 × 14/12 = 4.67
///   - joinDate Sep 1 2026, now Apr 4 2026 →
///       Not joined yet → 0
export function initialProRatedAccrual(args: {
  entitledDays: number
  joinDate: Date | null
  targetYear: number
  now: Date
}): number {
  const { entitledDays, joinDate, targetYear, now } = args
  if (entitledDays <= 0) return 0
  const monthlyChunk = entitledDays / 12

  // Determine the employee's "start month" within targetYear and
  // their partial-month credit for that month.
  let startMonth: number // 0-indexed
  let partialMonthFraction: number // (0, 1]

  const joinYear = joinDate?.getUTCFullYear() ?? null

  if (joinYear !== null && joinYear > targetYear) {
    // Hire date is in a future year — nothing to seed.
    return 0
  } else if (joinDate && joinYear === targetYear) {
    startMonth = joinDate.getUTCMonth()
    const joinDay = joinDate.getUTCDate()
    const daysInMonth = new Date(
      Date.UTC(targetYear, startMonth + 1, 0),
    ).getUTCDate()
    const daysWorked = Math.max(1, daysInMonth - joinDay + 1)
    partialMonthFraction = daysWorked / daysInMonth
  } else {
    // joined in a prior year, or unknown — treat as a full Jan.
    startMonth = 0
    partialMonthFraction = 1
  }

  // How many full month boundaries have been crossed in targetYear
  // by `now`? E.g. if now is Mar 5, that's month index 2; if
  // startMonth is 1 (Feb), 2 - 1 = 1 boundary (Mar 1) has crossed.
  let nowMonthInTarget: number
  if (now.getUTCFullYear() > targetYear) {
    nowMonthInTarget = 11 // all months elapsed
  } else if (now.getUTCFullYear() < targetYear) {
    return 0
  } else {
    nowMonthInTarget = now.getUTCMonth()
  }
  const fullMonthsCrossed = Math.max(0, nowMonthInTarget - startMonth)

  const seeded =
    fullMonthsCrossed * monthlyChunk + partialMonthFraction * monthlyChunk
  return Math.min(entitledDays, seeded)
}

/// Project a PRO_RATED entitlement's `accruedDays` value AS-OF an
/// arbitrary future (or past) date. Reuses the same semantics as the
/// initial-seed math, just with the target date passed in as `now` so
/// callers can ask "how many days would this employee have on
/// 2026-06-15?". Used by the forecasted-leave-apply check
/// (`allowForecastedLeaveApply` org toggle).
export function forecastAccruedOnDate(args: {
  entitledDays: number
  joinDate: Date | null
  asOf: Date
}): number {
  return initialProRatedAccrual({
    entitledDays: args.entitledDays,
    joinDate: args.joinDate,
    targetYear: args.asOf.getUTCFullYear(),
    now: args.asOf,
  })
}

/// Compute the carry-forward amount for next year, given this year's state.
/// Only used for leave types where `carryForward = true`.
///
/// - LUMP_SUM: remaining = entitledDays + carriedDays - usedDays
/// - PRO_RATED: remaining = accruedDays + carriedDays - usedDays
///   (un-accrued months are forfeited)
/// - Capped at maxCarryForwardDays (if set).
export function carryForwardAmount(input: {
  accrualMethod: LeaveAccrualMethod
  entitledDays: number
  accruedDays: number
  carriedDays: number
  usedDays: number
  maxCarryForwardDays: number | null
}): number {
  const base = input.accrualMethod === "PRO_RATED" ? input.accruedDays : input.entitledDays
  const remaining = Math.max(0, base + input.carriedDays - input.usedDays)
  if (input.maxCarryForwardDays == null) return remaining
  return Math.min(remaining, Math.max(0, input.maxCarryForwardDays))
}

/// Carried days that haven't been consumed yet, used for the expiry sweep.
/// We assume current-year bucket is consumed BEFORE carried bucket
/// (otherwise an employee would always race the clock).
export function unusedCarriedAtExpiry(input: {
  accrualMethod: LeaveAccrualMethod
  entitledDays: number
  accruedDays: number
  carriedDays: number
  usedDays: number
}): number {
  const currentBucket =
    input.accrualMethod === "PRO_RATED" ? input.accruedDays : input.entitledDays
  const usedFromCarry = Math.max(0, input.usedDays - currentBucket)
  return Math.max(0, input.carriedDays - usedFromCarry)
}
