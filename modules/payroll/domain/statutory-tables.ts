/**
 * Statutory contribution tables — official Third Schedule lookups.
 *
 * SOURCES (PDFs supplied by Simon, May 2026):
 *   - SOCSO  Act 4   "Rate of contribution for Employees Social Security Act 1969"
 *   - EIS    Act 800 "Rate of Contribution Employment Insurance System"
 *
 * Each table is a sorted array of { upTo, employer, employee }. The
 * lookup is "first row where wage <= upTo". The ceiling row uses
 * `Number.POSITIVE_INFINITY` and matches anything above the cap.
 *
 * For SOCSO, `employer2` is the Cat-2 (Employment Injury Only)
 * employer contribution; employee is 0 in Cat 2.
 */

export type StatutoryTableRow = {
  /// Inclusive upper wage bound for this row (RM).
  upTo: number
  /// Employer monthly contribution (RM).
  employer: number
  /// Employee monthly contribution (RM).
  employee: number
}

export type SocsoTableRow = StatutoryTableRow & {
  /// Cat-2 (Employment Injury Only) employer contribution.
  /// Used when employee is 60+ or is a foreign worker.
  employer2: number
}

// ─── SOCSO Act 4 Third Schedule ────────────────────────────────────────

export const SOCSO_TABLE: readonly SocsoTableRow[] = [
  { upTo: 30, employer: 0.4, employee: 0.1, employer2: 0.3 }, // row 1: Wages up to RM30
  { upTo: 50, employer: 0.7, employee: 0.2, employer2: 0.5 }, // row 2: When wages exceed RM30 but not exceed RM50
  { upTo: 70, employer: 1.1, employee: 0.3, employer2: 0.8 }, // row 3: When wages exceed RM50 but not exceed RM70
  { upTo: 100, employer: 1.5, employee: 0.4, employer2: 1.1 }, // row 4: When wages exceed RM70 but not exceed RM100
  { upTo: 140, employer: 2.1, employee: 0.6, employer2: 1.5 }, // row 5: When wages exceed RM100 but not exceed RM140
  { upTo: 200, employer: 2.95, employee: 0.85, employer2: 2.1 }, // row 6: When wages exceed RM140 but not exceed RM200
  { upTo: 300, employer: 4.35, employee: 1.25, employer2: 3.1 }, // row 7: When wages exceed RM200 but not exceed RM300
  { upTo: 400, employer: 6.15, employee: 1.75, employer2: 4.4 }, // row 8: When wages exceed RM300 but not exceed RM400/td>
  { upTo: 500, employer: 7.85, employee: 2.25, employer2: 5.6 }, // row 9: When wages exceed RM400 but not exceed RM500
  { upTo: 600, employer: 9.65, employee: 2.75, employer2: 6.9 }, // row 10: When wages exceed RM500 but not exceed RM600
  { upTo: 700, employer: 11.35, employee: 3.25, employer2: 8.1 }, // row 11: When wages exceed RM600 but not exceed RM700
  { upTo: 800, employer: 13.15, employee: 3.75, employer2: 9.4 }, // row 12: When wages exceed RM700 but not exceed RM800
  { upTo: 900, employer: 14.85, employee: 4.25, employer2: 10.6 }, // row 13: When wages exceed RM800 but not exceed RM900
  { upTo: 1000, employer: 16.65, employee: 4.75, employer2: 11.9 }, // row 14: When wages exceed RM900 but not exceed RM1,000
  { upTo: 1100, employer: 18.35, employee: 5.25, employer2: 13.1 }, // row 15: When wages exceed RM1,000 but not exceed RM1,100
  { upTo: 1200, employer: 20.15, employee: 5.75, employer2: 14.4 }, // row 16: When wages exceed RM1,100 but not exceed RM1,200
  { upTo: 1300, employer: 21.85, employee: 6.25, employer2: 15.6 }, // row 17: When wages exceed RM1,200 but not exceed RM1,300
  { upTo: 1400, employer: 23.65, employee: 6.75, employer2: 16.9 }, // row 18: When wages exceed RM1,300 but not exceed RM1,400
  { upTo: 1500, employer: 25.35, employee: 7.25, employer2: 18.1 }, // row 19: When wages exceed RM1,400 but not exceed RM1,500
  { upTo: 1600, employer: 27.15, employee: 7.75, employer2: 19.4 }, // row 20: When wages exceed RM1,500 but not exceed RM1,600
  { upTo: 1700, employer: 28.85, employee: 8.25, employer2: 20.6 }, // row 21: When wages exceed RM1,600 but not exceed RM1,700
  { upTo: 1800, employer: 30.65, employee: 8.75, employer2: 21.9 }, // row 22: When wages exceed RM1,700 but not exceed RM1,800
  { upTo: 1900, employer: 32.35, employee: 9.25, employer2: 23.1 }, // row 23: When wages exceed RM1,800 but not exceed RM1,900
  { upTo: 2000, employer: 34.15, employee: 9.75, employer2: 24.4 }, // row 24: When wages exceed RM1,900 but not exceed RM2,000
  { upTo: 2100, employer: 35.85, employee: 10.25, employer2: 25.6 }, // row 25: When wages exceed RM2,000 but not exceed RM2,100
  { upTo: 2200, employer: 37.65, employee: 10.75, employer2: 26.9 }, // row 26: When wages exceed RM2,100 but not exceed RM2,200
  { upTo: 2300, employer: 39.35, employee: 11.25, employer2: 28.1 }, // row 27: When wages exceed RM2,200 but not exceed RM2,300
  { upTo: 2400, employer: 41.15, employee: 11.75, employer2: 29.4 }, // row 28: When wages exceed RM2,300 but not exceed RM2,400
  { upTo: 2500, employer: 42.85, employee: 12.25, employer2: 30.6 }, // row 29: When wages exceed RM2,400 but not exceed RM2,500
  { upTo: 2600, employer: 44.65, employee: 12.75, employer2: 31.9 }, // row 30: When wages exceed RM2,500 but not exceed RM2,600
  { upTo: 2700, employer: 46.35, employee: 13.25, employer2: 33.1 }, // row 31: When wages exceed RM2,600 but not exceed RM2,700
  { upTo: 2800, employer: 48.15, employee: 13.75, employer2: 34.4 }, // row 32: When wages exceed RM2,700 but not exceed RM2,800
  { upTo: 2900, employer: 49.85, employee: 14.25, employer2: 35.6 }, // row 33: When wages exceed RM2,800 but not exceed RM2,900
  { upTo: 3000, employer: 51.65, employee: 14.75, employer2: 36.9 }, // row 34: When wages exceed RM2,900 but not exceed RM3,000
  { upTo: 3100, employer: 53.35, employee: 15.25, employer2: 38.1 }, // row 35: When wages exceed RM3,000 but not exceed RM3,100
  { upTo: 3200, employer: 55.15, employee: 15.75, employer2: 39.4 }, // row 36: When wages exceed RM3,100 but not exceed RM3,200
  { upTo: 3300, employer: 56.85, employee: 16.25, employer2: 40.6 }, // row 37: When wages exceed RM3,200 but not exceed RM3,300
  { upTo: 3400, employer: 58.65, employee: 16.75, employer2: 41.9 }, // row 38: When wages exceed RM3,300 but not exceed RM3,400
  { upTo: 3500, employer: 60.35, employee: 17.25, employer2: 43.1 }, // row 39: When wages exceed RM3,400 but not exceed RM3,500
  { upTo: 3600, employer: 62.15, employee: 17.75, employer2: 44.4 }, // row 40: When wages exceed RM3,500 but not exceed RM3,600
  { upTo: 3700, employer: 63.85, employee: 18.25, employer2: 45.6 }, // row 41: When wages exceed RM3,600 but not exceed RM3,700
  { upTo: 3800, employer: 65.65, employee: 18.75, employer2: 46.9 }, // row 42: When wages exceed RM3,700 but not exceed RM3,800
  { upTo: 3900, employer: 67.35, employee: 19.25, employer2: 48.1 }, // row 43: When wages exceed RM3,800 but not exceed RM3,900
  { upTo: 4000, employer: 69.15, employee: 19.75, employer2: 49.4 }, // row 44: When wages exceed RM3,900 but not exceed RM4,000
  { upTo: 4100, employer: 70.85, employee: 20.25, employer2: 50.6 }, // row 45: When wages exceed RM4,000 but not exceed RM4,100
  { upTo: 4200, employer: 72.65, employee: 20.75, employer2: 51.9 }, // row 46: When wages exceed RM4,100 but not exceed RM4,200
  { upTo: 4300, employer: 74.35, employee: 21.25, employer2: 53.1 }, // row 47: When wages exceed RM4,200 but not exceed RM4,300
  { upTo: 4400, employer: 76.15, employee: 21.75, employer2: 54.4 }, // row 48: When wages exceed RM4,300 but not exceed RM4,400
  { upTo: 4500, employer: 77.85, employee: 22.25, employer2: 55.6 }, // row 49: When wages exceed RM4,400 but not exceed RM4,500
  { upTo: 4600, employer: 79.65, employee: 22.75, employer2: 56.9 }, // row 50: When wages exceed RM4,500 but not exceed RM4,600
  { upTo: 4700, employer: 81.35, employee: 23.25, employer2: 58.1 }, // row 51: When wages exceed RM4,600 but not exceed RM4,700
  { upTo: 4800, employer: 83.15, employee: 23.75, employer2: 59.4 }, // row 52: When wages exceed RM4,700 but not exceed RM4,800
  { upTo: 4900, employer: 84.85, employee: 24.25, employer2: 60.6 }, // row 53: When wages exceed RM4,800 but not exceed RM4,900
  { upTo: 5000, employer: 86.65, employee: 24.75, employer2: 61.9 }, // row 54: When wages exceed RM4,900 but not exceed RM5,000
  { upTo: 5100, employer: 88.35, employee: 25.25, employer2: 63.1 }, // row 55: When wages exceed RM5,000 but not exceed RM5,100
  { upTo: 5200, employer: 90.15, employee: 25.75, employer2: 64.4 }, // row 56: When wages exceed RM5,100 but not exceed RM5,200
  { upTo: 5300, employer: 91.85, employee: 26.25, employer2: 65.6 }, // row 57: When wages exceed RM5,200 but not exceed RM5,300
  { upTo: 5400, employer: 93.65, employee: 26.75, employer2: 66.9 }, // row 58: When wages exceed RM5,300 but not exceed RM5,400
  { upTo: 5500, employer: 95.35, employee: 27.25, employer2: 68.1 }, // row 59: When wages exceed RM5,400 but not exceed RM5,500
  { upTo: 5600, employer: 97.15, employee: 27.75, employer2: 69.4 }, // row 60: When wages exceed RM5,500 but not exceed RM5,600
  { upTo: 5700, employer: 98.85, employee: 28.25, employer2: 70.6 }, // row 61: When wages exceed RM5,600 but not exceed RM5,700
  { upTo: 5800, employer: 100.65, employee: 28.75, employer2: 71.9 }, // row 62: When wages exceed RM5,700 but not exceed RM5,800
  { upTo: 5900, employer: 102.35, employee: 29.25, employer2: 73.1 }, // row 63: When wages exceed RM5,800 but not exceed RM5,900
  { upTo: 6000, employer: 104.15, employee: 29.75, employer2: 74.4 }, // row 64: When wages exceed RM5,900 but not exceed RM6,000
  { upTo: Number.POSITIVE_INFINITY, employer: 104.15, employee: 29.75, employer2: 74.4 }, // row 65: When wages exceed RM6,000
] as const

// ─── EIS Act 800 Third Schedule ────────────────────────────────────────

export const EIS_TABLE: readonly StatutoryTableRow[] = [
  { upTo: 30, employer: 0.05, employee: 0.05 }, // row 1: | Wages up to RM30
  { upTo: 50, employer: 0.1, employee: 0.1 }, // row 2: When wages exceed RM30 but not exceed RM50
  { upTo: 70, employer: 0.15, employee: 0.15 }, // row 3: When wages exceed RM50 but not exceed RM70
  { upTo: 100, employer: 0.2, employee: 0.2 }, // row 4: When wages exceed RM70 but not exceed RM100
  { upTo: 140, employer: 0.25, employee: 0.25 }, // row 5: When wages exceed RM100 but not exceed RM140
  { upTo: 200, employer: 0.35, employee: 0.35 }, // row 6: When wages exceed RM140 but not exceed RM200
  { upTo: 300, employer: 0.5, employee: 0.5 }, // row 7: When wages exceed RM200 but not exceed RM300
  { upTo: 400, employer: 0.7, employee: 0.7 }, // row 8: When wages exceed RM300 but not exceed RM400
  { upTo: 500, employer: 0.9, employee: 0.9 }, // row 9: When wages exceed RM400 but not exceed RM500
  { upTo: 600, employer: 1.1, employee: 1.1 }, // row 10: When wages exceed RM500 but not exceed RM600
  { upTo: 700, employer: 1.3, employee: 1.3 }, // row 11: When wages exceed RM600 but not exceed RM700
  { upTo: 800, employer: 1.5, employee: 1.5 }, // row 12: When wages exceed RM700 but not exceed RM800
  { upTo: 900, employer: 1.7, employee: 1.7 }, // row 13: When wages exceed RM800 but not exceed RM900
  { upTo: 1000, employer: 1.9, employee: 1.9 }, // row 14: When wages exceed RM900 but not exceed RM1,000
  { upTo: 1100, employer: 2.1, employee: 2.1 }, // row 15: When wages exceed RM1,000 but not exceed RM1,100
  { upTo: 1200, employer: 2.3, employee: 2.3 }, // row 16: When wages exceed RM1,100 but not exceed RM1,200
  { upTo: 1300, employer: 2.5, employee: 2.5 }, // row 17: When wages exceed RM1,200 but not exceed RM1,300
  { upTo: 1400, employer: 2.7, employee: 2.7 }, // row 18: When wages exceed RM1,300 but not exceed RM1,400
  { upTo: 1500, employer: 2.9, employee: 2.9 }, // row 19: When wages exceed RM1,400 but not exceed RM1,500
  { upTo: 1600, employer: 3.1, employee: 3.1 }, // row 20: When wages exceed RM1,500 but not exceed RM1,600
  { upTo: 1700, employer: 3.3, employee: 3.3 }, // row 21: When wages exceed RM1,600 but not exceed RM1,700
  { upTo: 1800, employer: 3.5, employee: 3.5 }, // row 22: When wages exceed RM1,700 but not exceed RM1,800
  { upTo: 1900, employer: 3.7, employee: 3.7 }, // row 23: When wages exceed RM1,800 but not exceed RM1,900
  { upTo: 2000, employer: 3.9, employee: 3.9 }, // row 24: When wages exceed RM1,900 but not exceed RM2,000
  { upTo: 2100, employer: 4.1, employee: 4.1 }, // row 25: When wages exceed RM2,000 but not exceed RM2,100
  { upTo: 2200, employer: 4.3, employee: 4.3 }, // row 26: When wages exceed RM2,100 but not exceed RM2,200
  { upTo: 2300, employer: 4.5, employee: 4.5 }, // row 27: When wages exceed RM2,200 but not exceed RM2,300
  { upTo: 2400, employer: 4.7, employee: 4.7 }, // row 28: When wages exceed RM2,300 but not exceed RM2,400
  { upTo: 2500, employer: 4.9, employee: 4.9 }, // row 29: When wages exceed RM2,400 but not exceed RM2,500
  { upTo: 2600, employer: 5.1, employee: 5.1 }, // row 30: When wages exceed RM2,500 but not exceed RM2,600
  { upTo: 2700, employer: 5.3, employee: 5.3 }, // row 31: When wages exceed RM2,600 but not exceed RM2,700
  { upTo: 2800, employer: 5.5, employee: 5.5 }, // row 32: When wages exceed RM2,700 but not exceed RM2,800
  { upTo: 2900, employer: 5.7, employee: 5.7 }, // row 33: When wages exceed RM2,800 but not exceed RM2,900
  { upTo: 3000, employer: 5.9, employee: 5.9 }, // row 34: When wages exceed RM2,900 but not exceed RM3,000
  { upTo: 3100, employer: 6.1, employee: 6.1 }, // row 35: When wages exceed RM3,000 but not exceed RM3,100
  { upTo: 3200, employer: 6.3, employee: 6.3 }, // row 36: When wages exceed RM3,100 but not exceed RM3,200
  { upTo: 3300, employer: 6.5, employee: 6.5 }, // row 37: When wages exceed RM3,200 but not exceed RM3,300
  { upTo: 3400, employer: 6.7, employee: 6.7 }, // row 38: When wages exceed RM3,300 but not exceed RM3,400
  { upTo: 3500, employer: 6.9, employee: 6.9 }, // row 39: When wages exceed RM3,400 but not exceed RM3,500
  { upTo: 3600, employer: 7.1, employee: 7.1 }, // row 40: When wages exceed RM3,500 but not exceed RM3,600
  { upTo: 3700, employer: 7.3, employee: 7.3 }, // row 41: When wages exceed RM3,600 but not exceed RM3,700
  { upTo: 3800, employer: 7.5, employee: 7.5 }, // row 42: When wages exceed RM3,700 but not exceed RM3,800
  { upTo: 3900, employer: 7.7, employee: 7.7 }, // row 43: When wages exceed RM3,800 but not exceed RM3,900
  { upTo: 4000, employer: 7.9, employee: 7.9 }, // row 44: When wages exceed RM3,900 but not exceed RM4,000
  { upTo: 4100, employer: 8.1, employee: 8.1 }, // row 45: When wages exceed RM4,000 but not exceed RM4,100
  { upTo: 4200, employer: 8.3, employee: 8.3 }, // row 46: When wages exceed RM4,100 but not exceed RM4,200
  { upTo: 4300, employer: 8.5, employee: 8.5 }, // row 47: When wages exceed RM4,200 but not exceed RM4,300
  { upTo: 4400, employer: 8.7, employee: 8.7 }, // row 48: When wages exceed RM4,300 but not exceed RM4,400
  { upTo: 4500, employer: 8.9, employee: 8.9 }, // row 49: When wages exceed RM4,400 but not exceed RM4,500
  { upTo: 4600, employer: 9.1, employee: 9.1 }, // row 50: When wages exceed RM4,500 but not exceed RM4,600
  { upTo: 4700, employer: 9.3, employee: 9.3 }, // row 51: When wages exceed RM4,600 but not exceed RM4,700
  { upTo: 4800, employer: 9.5, employee: 9.5 }, // row 52: When wages exceed RM4,700 but not exceed RM4,800
  { upTo: 4900, employer: 9.7, employee: 9.7 }, // row 53: When wages exceed RM4,800 but not exceed RM4,900
  { upTo: 5000, employer: 9.9, employee: 9.9 }, // row 54: When wages exceed RM4,900 but not exceed RM5,000
  { upTo: 5100, employer: 10.1, employee: 10.1 }, // row 55: When wages exceed RM5,000 but not exceed RM5,100
  { upTo: 5200, employer: 10.3, employee: 10.3 }, // row 56: When wages exceed RM5,100 but not exceed RM5,200
  { upTo: 5300, employer: 10.5, employee: 10.5 }, // row 57: When wages exceed RM5,200 but not exceed RM5,300
  { upTo: 5400, employer: 10.7, employee: 10.7 }, // row 58: When wages exceed RM5,300 but not exceed RM5,400
  { upTo: 5500, employer: 10.9, employee: 10.9 }, // row 59: When wages exceed RM5,400 but not exceed RM5,500
  { upTo: 5600, employer: 11.1, employee: 11.1 }, // row 60: When wages exceed RM5,500 but not exceed RM5,600
  { upTo: 5700, employer: 11.3, employee: 11.3 }, // row 61: When wages exceed RM5,600 but not exceed RM5,700
  { upTo: 5800, employer: 11.5, employee: 11.5 }, // row 62: When wages exceed RM5,700 but not exceed RM5,800
  { upTo: 5900, employer: 11.7, employee: 11.7 }, // row 63: When wages exceed RM5,800 but not exceed RM5,900
  { upTo: 6000, employer: 11.9, employee: 11.9 }, // row 64: When wages exceed RM5,900 but not exceed RM6,000
  { upTo: Number.POSITIVE_INFINITY, employer: 11.9, employee: 11.9 }, // row 65: When wages exceed RM6,000
] as const

/**
 * Look up a SOCSO contribution for the given wage.
 * Returns 0/0 if wage <= 0.
 */
export function lookupSocso(wage: number, category2: boolean): {
  employer: number
  employee: number
} {
  if (!Number.isFinite(wage) || wage <= 0) return { employer: 0, employee: 0 }
  for (const row of SOCSO_TABLE) {
    if (wage <= row.upTo) {
      if (category2) return { employer: row.employer2, employee: 0 }
      return { employer: row.employer, employee: row.employee }
    }
  }
  // Defensive — should never reach here because last row has upTo=Infinity
  const last = SOCSO_TABLE[SOCSO_TABLE.length - 1]
  if (category2) return { employer: last.employer2, employee: 0 }
  return { employer: last.employer, employee: last.employee }
}

/**
 * Look up an EIS contribution for the given wage.
 * Returns 0/0 if wage <= 0.
 */
export function lookupEis(wage: number): {
  employer: number
  employee: number
} {
  if (!Number.isFinite(wage) || wage <= 0) return { employer: 0, employee: 0 }
  for (const row of EIS_TABLE) {
    if (wage <= row.upTo) {
      return { employer: row.employer, employee: row.employee }
    }
  }
  const last = EIS_TABLE[EIS_TABLE.length - 1]
  return { employer: last.employer, employee: last.employee }
}

// ─── EPF Third Schedule — rule-based ───────────────────────────────────
//
// The KWSP Third Schedule for Parts A and C follows a fully-specified
// rule, not arbitrary table values. The actual 401-row tables (which
// we verified row-by-row against the gazetted PDF) are exactly:
//
//   - Wage  0.01 .. 10        → NIL (DE_MINIMIS, handled by calcEpf branch)
//   - Wage 10.01 .. 5,000     → RM 20 wage bands;  employer = ceil(rate_low × upperBound),
//                                                  employee = ceil(11% × upperBound)
//   - Wage 5,000.01 .. 20,000 → RM 100 wage bands; employer rate drops by 1pp at the
//                                                  cliff (13→12 for Part A, 6.5→6 for C)
//   - Wage > 20,000           → exact percentage, each side rounded up to the next ringgit
//
// Rate inputs for each branch:
//   Part A (Malaysian/PR/pre-1998 under 60):  emp_low=13, emp_high=12, ee=11
//   Part C (PR/pre-1998 60+):                  emp_low=6.5, emp_high=6, ee=5.5
//   Part E (Malaysian citizen 60+):            emp_low=4,   emp_high=4, ee=0   — no cliff
//   Part F (post-1998 non-MY, any age):        emp_low=2,   emp_high=2, ee=2   — no cliff

export function lookupEpfBand(input: {
  wage: number
  /// Employer rate (%) for wages ≤ RM 5,000 (Part A: 13, Part C: 6.5, Part E: 4, Part F: 2)
  employerRateLow: number
  /// Employer rate (%) for wages > RM 5,000 (Part A: 12, Part C: 6, Part E: 4, Part F: 2)
  employerRateHigh: number
  /// Employee rate (%) (Part A/C: 11/5.5, Part E: 0, Part F: 2)
  employeeRate: number
}): { employer: number; employee: number } {
  const { wage, employerRateLow, employerRateHigh, employeeRate } = input
  if (!Number.isFinite(wage) || wage <= 10) return { employer: 0, employee: 0 }
  let upper: number
  let employerRate: number
  if (wage <= 5000) {
    // RM 20 wage bands. upperBound = ceil(wage/20) × 20.
    upper = Math.ceil(wage / 20) * 20
    employerRate = employerRateLow
  } else if (wage <= 20000) {
    // RM 100 wage bands. upperBound = ceil(wage/100) × 100.
    upper = Math.ceil(wage / 100) * 100
    employerRate = employerRateHigh
  } else {
    // Above RM 20,000: exact percentage, each side rounded UP to
    // next ringgit per KWSP Third Schedule Note 2.
    return {
      employer: Math.ceil(wage * employerRateHigh / 100),
      employee: Math.ceil(wage * employeeRate / 100),
    }
  }
  return {
    employer: Math.ceil(upper * employerRate / 100),
    employee: Math.ceil(upper * employeeRate / 100),
  }
}

// ─── SOCSO scheme recommender ────────────────────────────────────────────

/**
 * Years between two dates, accounting for whether the birthday has
 * already passed in the reference year. Returns 0 when dob is in the
 * future (defensive).
 */
export function calculateAge(dob: Date, asOf: Date = new Date()): number {
  let age = asOf.getFullYear() - dob.getFullYear()
  const m = asOf.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && asOf.getDate() < dob.getDate())) age--
  return Math.max(0, age)
}

/**
 * Recommend a SOCSO scheme based on PERKESO's classification rules.
 *
 * Rules (per the FusionETA accountant):
 *
 *   1. Age < 55                    → Scheme 1 (Injury + Invalidity)
 *   2. Age ≥ 60                    → Scheme 2 (Employment Injury only)
 *   3. Age 55–59                   → null (AMBIGUOUS — depends on whether
 *                                          the employee is a first-time
 *                                          SOCSO registrant, which the
 *                                          system cannot reliably detect)
 *
 * We deliberately do NOT try to guess the 55–59 case from a blank
 * `socsoNumber` field — an admin who forgot to key it in would be
 * silently misclassified, and the misclassification only surfaces
 * when PERKESO rejects the contribution. Better to leave the
 * dropdown unset and prompt the admin to pick manually.
 *
 * Use `socsoSchemeNeedsManualChoice(dateOfBirth)` to detect the 55–59
 * window in the UI so you can render an appropriate hint.
 *
 * Returns null when we can't recommend (missing DOB, or ambiguous age).
 */
export function recommendSocsoScheme(input: {
  dateOfBirth: Date | null
  asOf?: Date
}): "EMPLOYMENT_INJURY_INVALIDITY" | "EMPLOYMENT_INJURY_ONLY" | null {
  if (input.dateOfBirth == null) return null
  const age = calculateAge(input.dateOfBirth, input.asOf ?? new Date())

  if (age >= 60) return "EMPLOYMENT_INJURY_ONLY"
  if (age >= 55) return null // 55–59: admin must pick manually
  return "EMPLOYMENT_INJURY_INVALIDITY"
}

/**
 * True when the employee falls in the age 55–59 window where the SOCSO
 * scheme depends on whether they're a first-time PERKESO registrant.
 * The UI should surface a hint asking the admin to pick manually rather
 * than auto-filling the dropdown.
 */
export function socsoSchemeNeedsManualChoice(input: {
  dateOfBirth: Date | null
  asOf?: Date
}): boolean {
  if (input.dateOfBirth == null) return false
  const age = calculateAge(input.dateOfBirth, input.asOf ?? new Date())
  return age >= 55 && age < 60
}
