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
