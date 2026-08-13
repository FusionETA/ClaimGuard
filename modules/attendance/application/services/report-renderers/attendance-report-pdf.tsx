import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer"

import type { AttendanceStatus } from "@/modules/attendance/domain/models"

// ─── Types ─────────────────────────────────────────────────────────────────

export type AttendanceDayRow =
  | { kind: "holiday"; date: string; dayName: string; holidayName: string }
  | { kind: "rest"; date: string; dayName: string }
  | { kind: "leave"; date: string; dayName: string; leaveTypeName: string; leaveStatus: string }
  | { kind: "work"; date: string; dayName: string; timeIn: string | null; timeOut: string | null; totalHours: string; status: AttendanceStatus; project: string | null }

export type AttendanceReportDocumentProps = {
  organizationName: string
  employeeName: string
  department: string | null
  periodLabel: string
  rows: AttendanceDayRow[]
  generatedAt: string
}

// ─── Colours / typography ──────────────────────────────────────────────────

const C = {
  ink: "#0f172a",
  muted: "#64748b",
  faint: "#94a3b8",
  divider: "#e2e8f0",
  headerBlue: "#1e40af",
  headerText: "#ffffff",
  leaveYellow: "#fef9c3",
  restGray: "#f1f5f9",
  altRow: "#f8fafc",
}

const s = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 40,
    fontSize: 9,
    color: C.ink,
    fontFamily: "Helvetica",
  },
  headerOrg: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  headerTitle: { fontSize: 11, color: C.muted, marginTop: 2 },
  headerMeta: { fontSize: 9, color: C.muted, marginTop: 6 },
  headerMetaLine: { marginTop: 2 },
  divider: { borderTopWidth: 0.5, borderTopColor: C.divider, marginTop: 10, marginBottom: 10 },
  tableRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: C.divider },
  colDate: { width: "14%", paddingVertical: 5, paddingHorizontal: 4 },
  colDay: { width: "8%", paddingVertical: 5, paddingHorizontal: 4 },
  colIn: { width: "15%", paddingVertical: 5, paddingHorizontal: 4 },
  colOut: { width: "15%", paddingVertical: 5, paddingHorizontal: 4 },
  colHours: { width: "18%", paddingVertical: 5, paddingHorizontal: 4 },
  colProject: { width: "30%", paddingVertical: 5, paddingHorizontal: 4 },
  tHeaderText: { fontSize: 8, fontFamily: "Helvetica-Bold", color: C.headerText },
  cellText: { fontSize: 8.5 },
  mutedText: { fontSize: 8.5, color: C.muted },
  footer: {
    position: "absolute",
    bottom: 18,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: C.faint,
  },
})

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtDate(dateStr: string): string {
  // dateStr is yyyy-mm-dd
  const [y, m, d] = dateStr.split("-").map(Number)
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${d} ${months[m - 1]} ${y}`
}

// ─── Table Header ──────────────────────────────────────────────────────────

function TableHeader() {
  return (
    <View style={[s.tableRow, { backgroundColor: C.headerBlue, borderBottomWidth: 0 }]}>
      <View style={s.colDate}><Text style={s.tHeaderText}>Date</Text></View>
      <View style={s.colDay}><Text style={s.tHeaderText}>Day</Text></View>
      <View style={s.colIn}><Text style={s.tHeaderText}>Time In</Text></View>
      <View style={s.colOut}><Text style={s.tHeaderText}>Time Out</Text></View>
      <View style={s.colHours}><Text style={s.tHeaderText}>Total Hours</Text></View>
      <View style={s.colProject}><Text style={s.tHeaderText}>Project</Text></View>
    </View>
  )
}

// ─── Table Rows ────────────────────────────────────────────────────────────

function DayRow({ row, index }: { row: AttendanceDayRow; index: number }) {
  const bg = row.kind === "leave"
    ? C.leaveYellow
    : row.kind === "rest" || row.kind === "holiday"
      ? C.restGray
      : index % 2 === 1
        ? C.altRow
        : "#ffffff"

  if (row.kind === "holiday") {
    return (
      <View style={[s.tableRow, { backgroundColor: bg }]}>
        <View style={s.colDate}><Text style={s.cellText}>{fmtDate(row.date)}</Text></View>
        <View style={s.colDay}><Text style={[s.cellText, { color: C.muted }]}>{row.dayName}</Text></View>
        <View style={{ width: "78%", paddingVertical: 5, paddingHorizontal: 4 }}>
          <Text style={[s.cellText, { color: C.muted, fontFamily: "Helvetica-Oblique" }]}>{row.holidayName}</Text>
        </View>
      </View>
    )
  }

  if (row.kind === "rest") {
    return (
      <View style={[s.tableRow, { backgroundColor: bg }]}>
        <View style={s.colDate}><Text style={s.cellText}>{fmtDate(row.date)}</Text></View>
        <View style={s.colDay}><Text style={[s.cellText, { color: C.muted }]}>{row.dayName}</Text></View>
        <View style={{ width: "78%", paddingVertical: 5, paddingHorizontal: 4 }}>
          <Text style={[s.cellText, { color: C.muted, fontFamily: "Helvetica-Oblique" }]}>Weekly Holiday</Text>
        </View>
      </View>
    )
  }

  if (row.kind === "leave") {
    const label = `Leave (${row.leaveTypeName} – ${row.leaveStatus})`
    return (
      <View style={[s.tableRow, { backgroundColor: bg }]}>
        <View style={s.colDate}><Text style={s.cellText}>{fmtDate(row.date)}</Text></View>
        <View style={s.colDay}><Text style={[s.cellText, { color: C.muted }]}>{row.dayName}</Text></View>
        <View style={{ width: "78%", paddingVertical: 5, paddingHorizontal: 4 }}>
          <Text style={[s.cellText, { color: "#854d0e" }]}>{label}</Text>
        </View>
      </View>
    )
  }

  // kind === "work"
  return (
    <View style={[s.tableRow, { backgroundColor: bg }]}>
      <View style={s.colDate}><Text style={s.cellText}>{fmtDate(row.date)}</Text></View>
      <View style={s.colDay}><Text style={[s.cellText, { color: C.muted }]}>{row.dayName}</Text></View>
      <View style={s.colIn}>
        <Text style={row.timeIn ? s.cellText : s.mutedText}>{row.timeIn ?? "—"}</Text>
      </View>
      <View style={s.colOut}>
        <Text style={row.timeOut ? s.cellText : s.mutedText}>{row.timeOut ?? "—"}</Text>
      </View>
      <View style={s.colHours}>
        <Text style={row.totalHours === "—" ? s.mutedText : s.cellText}>{row.totalHours}</Text>
      </View>
      <View style={s.colProject}>
        <Text style={row.project ? s.cellText : s.mutedText}>{row.project ?? "—"}</Text>
      </View>
    </View>
  )
}

// ─── Document ──────────────────────────────────────────────────────────────

export function AttendanceReportDocument(props: AttendanceReportDocumentProps) {
  const { organizationName, employeeName, department, periodLabel, rows, generatedAt } = props

  return (
    <Document title="Attendance Report" author={organizationName}>
      <Page size="A4" style={s.page}>
        {/* Header */}
        <Text style={s.headerOrg}>{organizationName}</Text>
        <Text style={s.headerTitle}>ATTENDANCE REPORT</Text>
        <View style={s.headerMeta}>
          <Text style={s.headerMetaLine}>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>Employee: </Text>
            {employeeName}
          </Text>
          {department ? (
            <Text style={s.headerMetaLine}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Department: </Text>
              {department}
            </Text>
          ) : null}
          <Text style={s.headerMetaLine}>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>Period: </Text>
            {periodLabel}
          </Text>
        </View>
        <View style={s.divider} />

        {/* Table */}
        <TableHeader />
        {rows.map((row, i) => (
          <DayRow key={row.date} row={row} index={i} />
        ))}

        {/* Footer */}
        <View style={s.footer} fixed>
          <Text>Generated on {generatedAt}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

// ─── Multi-employee (bulk) variant ─────────────────────────────────────────

export type AttendanceReportEmployeeSection = AttendanceReportDocumentProps

export function AttendanceReportBulkDocument(props: {
  sections: AttendanceReportEmployeeSection[]
  generatedAt: string
}) {
  return (
    <Document title="Attendance Report" author="">
      {props.sections.map((section, idx) => (
        <Page key={idx} size="A4" style={s.page}>
          {/* Header */}
          <Text style={s.headerOrg}>{section.organizationName}</Text>
          <Text style={s.headerTitle}>ATTENDANCE REPORT</Text>
          <View style={s.headerMeta}>
            <Text style={s.headerMetaLine}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Employee: </Text>
              {section.employeeName}
            </Text>
            {section.department ? (
              <Text style={s.headerMetaLine}>
                <Text style={{ fontFamily: "Helvetica-Bold" }}>Department: </Text>
                {section.department}
              </Text>
            ) : null}
            <Text style={s.headerMetaLine}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Period: </Text>
              {section.periodLabel}
            </Text>
          </View>
          <View style={s.divider} />
          <TableHeader />
          {section.rows.map((row, i) => (
            <DayRow key={row.date} row={row} index={i} />
          ))}
          <View style={s.footer} fixed>
            <Text>Generated on {props.generatedAt}</Text>
            <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
          </View>
        </Page>
      ))}
    </Document>
  )
}
