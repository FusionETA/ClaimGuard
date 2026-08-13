import "server-only"

import JSZip from "jszip"
import { renderToBuffer } from "@react-pdf/renderer"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import { parseWorkingDays, isoWeekday } from "@/modules/attendance/domain/hours-summary"
import { sanitiseFilenamePart } from "@/lib/filename"
import {
  AttendanceReportDocument,
  AttendanceReportBulkDocument,
  type AttendanceDayRow,
  type AttendanceReportEmployeeSection,
} from "@/modules/attendance/application/services/report-renderers/attendance-report-pdf"

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number)
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${d} ${months[m - 1]} ${y}`
}

function fmtDuration(min: number | null): string {
  if (!min || min <= 0) return "—"
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

function fmtTime(iso: string | null, tz: string): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleTimeString("en-MY", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  })
}

function dayName(dateStr: string): string {
  // dateStr is yyyy-mm-dd, parse as local midnight UTC
  const d = new Date(dateStr + "T00:00:00Z")
  return d.toLocaleDateString("en-MY", { weekday: "short", timeZone: "UTC" })
}

function fmtPeriod(from: Date, to: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  function fmt(d: Date) {
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  }
  return `${fmt(from)} – ${fmt(to)}`
}

function fmtNow(): string {
  return new Date().toLocaleString("en-MY", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  })
}

// ─── Core data builder for one employee ───────────────────────────────────

async function buildEmployeeSection(
  orgId: string,
  employeeId: string,
  employeeName: string,
  department: string | null,
  orgName: string,
  from: Date,
  to: Date,
  timezone: string,
  orgHolidayMap: Map<string, string>,
  generatedAt: string,
): Promise<AttendanceReportEmployeeSection> {
  const [attendanceRecords, projectAssignments, leaveApplications, projectByDate] =
    await Promise.all([
      attendanceRepository.getAttendanceHistory(employeeId, from, to),
      attendanceRepository.getEmployeeProjectAssignments(employeeId, orgId),
      leaveRepository.listApplicationsForEmployee(employeeId),
      attendanceRepository.getAttendanceProjectsForRange(employeeId, from, to),
    ])

  // Index attendance records by date string (yyyy-mm-dd)
  const recordByDate = new Map(attendanceRecords.map((r) => [r.date, r]))

  // Working days from primary project, fall back to Mon-Fri
  const primaryProject = projectAssignments?.assignments[0] ?? null
  const workingDays = parseWorkingDays(primaryProject?.workingDays ?? null)

  // Build leave overlay: map date → { leaveTypeName, leaveStatus }
  const leaveByDate = new Map<string, { leaveTypeName: string; leaveStatus: string }>()
  const fromStr = from.toISOString().slice(0, 10)
  const toStr = to.toISOString().slice(0, 10)
  for (const app of leaveApplications) {
    if (app.status !== "APPROVED" && app.status !== "PENDING") continue
    // Iterate every date in the application range
    const appStart = new Date(app.startDate)
    const appEnd = new Date(app.endDate)
    const cur = new Date(appStart)
    while (cur <= appEnd) {
      const ds = cur.toISOString().slice(0, 10)
      if (ds >= fromStr && ds <= toStr) {
        leaveByDate.set(ds, {
          leaveTypeName: app.leaveTypeName,
          leaveStatus: app.status === "APPROVED" ? "Approved" : "Pending",
        })
      }
      cur.setUTCDate(cur.getUTCDate() + 1)
    }
  }

  // Enumerate all calendar days in range
  const rows: AttendanceDayRow[] = []
  const cur = new Date(from)
  while (cur <= to) {
    const dateStr = cur.toISOString().slice(0, 10)
    const dn = dayName(dateStr)
    const isHoliday = orgHolidayMap.has(dateStr)
    const isRestDay = !workingDays.has(isoWeekday(cur))
    const record = recordByDate.get(dateStr)
    const leaveInfo = leaveByDate.get(dateStr)

    if (isHoliday) {
      rows.push({ kind: "holiday", date: dateStr, dayName: dn, holidayName: orgHolidayMap.get(dateStr)! })
    } else if (isRestDay) {
      rows.push({ kind: "rest", date: dateStr, dayName: dn })
    } else if (record?.status === "ON_LEAVE" || leaveInfo) {
      rows.push({
        kind: "leave",
        date: dateStr,
        dayName: dn,
        leaveTypeName: leaveInfo?.leaveTypeName ?? "Leave",
        leaveStatus: leaveInfo?.leaveStatus ?? "Approved",
      })
    } else {
      rows.push({
        kind: "work",
        date: dateStr,
        dayName: dn,
        timeIn: record ? fmtTime(record.timeIn, timezone) : null,
        timeOut: record ? fmtTime(record.timeOut, timezone) : null,
        totalHours: record ? fmtDuration(record.durationMin) : "—",
        status: record?.status ?? "MISSING",
        project: projectByDate.get(dateStr) ?? null,
      })
    }

    cur.setUTCDate(cur.getUTCDate() + 1)
  }

  return {
    organizationName: orgName,
    employeeName,
    department,
    periodLabel: fmtPeriod(from, to),
    rows,
    generatedAt,
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function generateAttendancePdf(
  orgId: string,
  employeeId: string,
  from: Date,
  to: Date,
): Promise<Buffer> {
  const [org, timezone, employees, holidays] = await Promise.all([
    organizationRepository.getOrganizationById(orgId),
    attendanceRepository.getOrgTimezone(orgId),
    attendanceRepository.getOrgEmployeeList(orgId),
    organizationRepository.getOrgHolidays(orgId),
  ])

  const orgName = org?.name ?? "Organization"
  const emp = employees.find((e) => e.id === employeeId)
  if (!emp) throw new Error("Employee not found in this organization.")

  const orgHolidayMap = new Map(holidays.map((h) => [h.date, h.name]))
  const generatedAt = fmtNow()

  const section = await buildEmployeeSection(
    orgId, employeeId, emp.name, emp.project,
    orgName, from, to, timezone, orgHolidayMap, generatedAt,
  )

  return renderToBuffer(<AttendanceReportDocument {...section} />)
}

/**
 * Bulk attendance export — one PDF per employee, all bundled into a
 * single ZIP. Replaces the previous combined-PDF bulk renderer so HR
 * can forward individual reports without splitting a giant file first.
 * Same rationale as `bulk-payslips-pdf.tsx`.
 */
/**
 * Shared prep for both team outputs: load org context + build one section
 * per in-scope employee. Throws when the scope resolves to nobody so the
 * caller can surface a clean 500 instead of emitting an empty document.
 */
async function buildAllSections(
  orgId: string,
  from: Date,
  to: Date,
  userIds?: string[],
): Promise<{ sections: AttendanceReportEmployeeSection[]; generatedAt: string }> {
  const [org, timezone, allEmployees, holidays] = await Promise.all([
    organizationRepository.getOrganizationById(orgId),
    attendanceRepository.getOrgTimezone(orgId),
    attendanceRepository.getOrgEmployeeList(orgId),
    organizationRepository.getOrgHolidays(orgId),
  ])

  const employees = userIds?.length
    ? allEmployees.filter((e) => userIds.includes(e.id))
    : allEmployees

  if (employees.length === 0) throw new Error("No employees found.")

  const orgName = org?.name ?? "Organization"
  const orgHolidayMap = new Map(holidays.map((h) => [h.date, h.name]))
  const generatedAt = fmtNow()

  const sections = await Promise.all(
    employees.map((emp) =>
      buildEmployeeSection(
        orgId, emp.id, emp.name, emp.project,
        orgName, from, to, timezone, orgHolidayMap, generatedAt,
      ),
    ),
  )
  return { sections, generatedAt }
}

/**
 * ONE combined PDF for the whole team — a page per employee in a single
 * document. Backs the team-report route (supervisor → their team,
 * admin/owner → the org). Rendering one document (vs. one buffer per
 * employee) is both correct for an `application/pdf` response and far
 * lighter on memory for large orgs.
 */
export async function generateTeamAttendancePdf(
  orgId: string,
  from: Date,
  to: Date,
  userIds?: string[],
): Promise<Buffer> {
  const { sections, generatedAt } = await buildAllSections(orgId, from, to, userIds)
  return renderToBuffer(
    <AttendanceReportBulkDocument sections={sections} generatedAt={generatedAt} />,
  )
}

/**
 * ZIP of per-employee PDFs — one file each, so HR can forward an
 * individual's report without splitting a combined document. Backs the
 * admin bulk-export route.
 */
export async function generateAttendancePdfBulk(
  orgId: string,
  from: Date,
  to: Date,
  userIds?: string[],
): Promise<Buffer> {
  const { sections } = await buildAllSections(orgId, from, to, userIds)

  // @react-pdf is CPU-heavy; a throttle may be warranted past ~200
  // employees but typical SME runs (≤100) stay well under a minute.
  const pdfBuffers = await Promise.all(
    sections.map((section) =>
      renderToBuffer(<AttendanceReportDocument {...section} />),
    ),
  )

  const rangeTag = `${from.toISOString().slice(0, 10)}_to_${to.toISOString().slice(0, 10)}`
  const zip = new JSZip()
  const used = new Set<string>()
  for (let i = 0; i < sections.length; i += 1) {
    const name = uniqueName(
      used,
      `${sanitiseFilenamePart(sections[i].employeeName) || "Employee"}_${rangeTag}.pdf`,
    )
    zip.file(name, pdfBuffers[i])
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

function uniqueName(used: Set<string>, base: string): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  const [, stem, ext] = base.match(/^(.+)(\.[^.]+)$/) ?? [null, base, ""]
  let n = 2
  while (used.has(`${stem}_${n}${ext}`)) n += 1
  const name = `${stem}_${n}${ext}`
  used.add(name)
  return name
}
