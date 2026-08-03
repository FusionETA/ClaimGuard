import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { AttendanceDailyDocument } from "@/modules/attendance/application/services/report-renderers/attendance-daily-pdf"
import { renderDailyAttendanceExcel } from "@/modules/attendance/application/services/report-renderers/attendance-daily-excel"

/**
 * Shared data builder for the day-by-day attendance exports (PDF and
 * Excel). Both renderers consume exactly this shape, so the two formats
 * can't drift apart — one day per section/sheet, one row per employee in
 * scope, absences included.
 */

/** Shown when the employee has neither an attendance record nor leave. */
export const NO_RECORD_LABEL = "No Leave / Attendance Record Found"

export type DailyAttendanceRow = {
  /** 1-based, resets each day — the "NO" column. */
  no: number
  name: string
  designation: string
  department: string
  /** Formatted clock-in, or "-" when absent. */
  checkedIn: string
  checkedOut: string
  /**
   * Leave type when on leave, {@link NO_RECORD_LABEL} when there's
   * nothing at all, empty when the employee simply worked.
   */
  leaveStatus: string
}

export type DailyAttendanceDay = {
  /** yyyy-mm-dd — used for the Excel sheet name. */
  date: string
  /** dd/MM/yyyy — used in the banner heading. */
  dateLabel: string
  rows: DailyAttendanceRow[]
}

export type DailyAttendanceReport = {
  organizationName: string
  /** Human-readable range, for the filename and the PDF footer. */
  periodLabel: string
  days: DailyAttendanceDay[]
}

export type DailyExportEmployee = {
  id: string
  name: string
  jobTitle: string | null
  department: string | null
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** dd/MM/yyyy, matching the heading format of the source workbook. */
function fmtDayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split("-")
  return `${d}/${m}/${y}`
}

function fmtClock(iso: string | null, timezone: string): string {
  if (!iso) return "-"
  // 12-hour with AM/PM, e.g. "08:32 AM".
  return new Date(iso)
    .toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    })
    .toUpperCase()
}

function fmtPeriod(from: Date, to: Date): string {
  const a = fmtDayLabel(toDateKey(from))
  const b = fmtDayLabel(toDateKey(to))
  return a === b ? a : `${a} – ${b}`
}

/**
 * Every calendar day in [from, to] inclusive, as yyyy-mm-dd keys.
 * Rest days and holidays are NOT skipped — the report is a daily roll
 * call, and a day where nobody clocked in is itself information.
 */
function enumerateDays(from: Date, to: Date): string[] {
  const out: string[] = []
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()))
  while (cur <= end) {
    out.push(toDateKey(cur))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

export async function buildDailyAttendanceReport(args: {
  orgId: string
  from: Date
  to: Date
  employees: DailyExportEmployee[]
}): Promise<DailyAttendanceReport> {
  const { orgId, from, to, employees } = args
  const employeeIds = employees.map((e) => e.id)

  const [org, timezone, records, leaves] = await Promise.all([
    organizationRepository.getOrganizationById(orgId),
    attendanceRepository.getOrgTimezone(orgId),
    attendanceRepository.getAttendanceForEmployeesInRange(employeeIds, from, to),
    leaveRepository.listApplicationsInRangeForUsers(employeeIds, from, to),
  ])

  // (employeeId, date) → record
  const recordIndex = new Map<string, (typeof records)[number]>()
  for (const r of records) recordIndex.set(`${r.employeeId}|${r.date}`, r)

  // (employeeId, date) → leave label. A multi-day application is
  // expanded across each day it covers so the daily lookup is O(1).
  //
  // Pending leave is labelled as such: it's a request, not an approved
  // absence, and a report that renders the two identically invites
  // signing off on leave nobody granted.
  const leaveIndex = new Map<string, string>()
  const fromKey = toDateKey(from)
  const toKey = toDateKey(to)
  for (const app of leaves) {
    const label =
      app.status === "PENDING"
        ? `${app.leaveTypeName} (Pending)`
        : app.leaveTypeName
    const cur = new Date(app.startDate)
    while (cur <= app.endDate) {
      const key = toDateKey(cur)
      if (key >= fromKey && key <= toKey) {
        // An approved application beats a pending one on the same day.
        const existing = leaveIndex.get(`${app.userId}|${key}`)
        if (!existing || app.status === "APPROVED") {
          leaveIndex.set(`${app.userId}|${key}`, label)
        }
      }
      cur.setUTCDate(cur.getUTCDate() + 1)
    }
  }

  const days: DailyAttendanceDay[] = enumerateDays(from, to).map((date) => ({
    date,
    dateLabel: fmtDayLabel(date),
    rows: employees.map((emp, index) => {
      const record = recordIndex.get(`${emp.id}|${date}`)
      const leaveTypeName = leaveIndex.get(`${emp.id}|${date}`)
      const checkedIn = fmtClock(record?.timeIn ?? null, timezone)
      const checkedOut = fmtClock(record?.timeOut ?? null, timezone)
      const worked = checkedIn !== "-" || checkedOut !== "-"

      return {
        no: index + 1,
        name: emp.name,
        designation: emp.jobTitle ?? "",
        department: emp.department ?? "",
        checkedIn,
        checkedOut,
        // Leave wins over "nothing found"; a day that was actually
        // worked gets a blank cell rather than noise.
        leaveStatus: leaveTypeName ?? (worked ? "" : NO_RECORD_LABEL),
      }
    }),
  }))

  return {
    organizationName: org?.name ?? "Organization",
    periodLabel: fmtPeriod(from, to),
    days,
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

function fmtNow(): string {
  return new Date().toLocaleString("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Filename stem shared by both formats, e.g. `attendance-2026-08-01_to_2026-08-03`. */
export function dailyExportFilename(from: Date, to: Date, ext: string): string {
  const a = toDateKey(from)
  const b = toDateKey(to)
  const range = a === b ? a : `${a}_to_${b}`
  return `attendance-${range}.${ext}`
}

export async function generateDailyAttendancePdf(args: {
  orgId: string
  from: Date
  to: Date
  employees: DailyExportEmployee[]
}): Promise<Buffer> {
  const report = await buildDailyAttendanceReport(args)
  return renderToBuffer(
    <AttendanceDailyDocument report={report} generatedAt={fmtNow()} />,
  )
}

export async function generateDailyAttendanceExcel(args: {
  orgId: string
  from: Date
  to: Date
  employees: DailyExportEmployee[]
}): Promise<Buffer> {
  const report = await buildDailyAttendanceReport(args)
  return renderDailyAttendanceExcel(report)
}
