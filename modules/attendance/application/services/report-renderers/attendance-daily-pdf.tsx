import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer"

import type { DailyAttendanceReport } from "@/modules/attendance/application/services/attendance-daily-export.service"

/**
 * Day-by-day attendance report — one page per day, one row per employee
 * in scope. Mirrors the Excel export sheet-for-sheet so the two formats
 * show the same thing.
 */

const C = {
  ink: "#0f172a",
  muted: "#64748b",
  divider: "#d4d4d8",
  brand: "#4C1A86",
  brandText: "#ffffff",
  altRow: "#faf8fd",
}

/** Must total 100. Mirrors the Excel column widths. */
const W = {
  no: "5%",
  name: "26%",
  designation: "18%",
  department: "13%",
  in: "11%",
  out: "11%",
  leave: "16%",
} as const

const s = StyleSheet.create({
  page: {
    paddingTop: 28,
    paddingBottom: 40,
    paddingHorizontal: 24,
    fontSize: 8,
    color: C.ink,
    fontFamily: "Helvetica",
  },
  banner: {
    backgroundColor: C.brand,
    paddingVertical: 8,
    paddingHorizontal: 10,
    textAlign: "center",
  },
  bannerTitle: {
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    color: C.brandText,
  },
  bannerOrg: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: C.brandText,
    marginTop: 3,
  },
  headRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: C.ink,
    marginTop: 10,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: C.divider,
  },
  rowAlt: { backgroundColor: C.altRow },
  cell: { paddingVertical: 4, paddingHorizontal: 3 },
  headText: { fontSize: 7.5, fontFamily: "Helvetica-Bold" },
  cellText: { fontSize: 7.5 },
  mutedText: { fontSize: 7, color: C.muted },
  empty: {
    marginTop: 14,
    fontSize: 9,
    color: C.muted,
    textAlign: "center",
  },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 24,
    right: 24,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: C.muted,
  },
})

function HeaderRow() {
  return (
    <View style={s.headRow} fixed>
      <View style={[s.cell, { width: W.no }]}>
        <Text style={s.headText}>NO</Text>
      </View>
      <View style={[s.cell, { width: W.name }]}>
        <Text style={s.headText}>NAME</Text>
      </View>
      <View style={[s.cell, { width: W.designation }]}>
        <Text style={s.headText}>DESIGNATION</Text>
      </View>
      <View style={[s.cell, { width: W.department }]}>
        <Text style={s.headText}>DEPARTMENT</Text>
      </View>
      <View style={[s.cell, { width: W.in }]}>
        <Text style={s.headText}>CHECKED-IN</Text>
      </View>
      <View style={[s.cell, { width: W.out }]}>
        <Text style={s.headText}>CHECKED-OUT</Text>
      </View>
      <View style={[s.cell, { width: W.leave }]}>
        <Text style={s.headText}>LEAVE STATUS</Text>
      </View>
    </View>
  )
}

export function AttendanceDailyDocument({
  report,
  generatedAt,
}: {
  report: DailyAttendanceReport
  generatedAt: string
}) {
  return (
    <Document
      title={`Attendance ${report.periodLabel}`}
      author="AltomateHR"
    >
      {report.days.map((day) => (
        <Page key={day.date} size="A4" orientation="landscape" style={s.page}>
          <View style={s.banner}>
            <Text style={s.bannerTitle}>ATTENDANCE - {day.dateLabel}</Text>
            <Text style={s.bannerOrg}>{report.organizationName}</Text>
          </View>

          <HeaderRow />

          {day.rows.length === 0 ? (
            <Text style={s.empty}>No employees in the selected filter.</Text>
          ) : (
            day.rows.map((row, i) => (
              <View
                key={`${day.date}-${row.no}`}
                style={i % 2 === 1 ? [s.row, s.rowAlt] : s.row}
                wrap={false}
              >
                <View style={[s.cell, { width: W.no }]}>
                  <Text style={s.cellText}>{row.no}</Text>
                </View>
                <View style={[s.cell, { width: W.name }]}>
                  <Text style={s.cellText}>{row.name}</Text>
                </View>
                <View style={[s.cell, { width: W.designation }]}>
                  <Text style={s.cellText}>{row.designation || "—"}</Text>
                </View>
                <View style={[s.cell, { width: W.department }]}>
                  <Text style={s.cellText}>{row.department || "—"}</Text>
                </View>
                <View style={[s.cell, { width: W.in }]}>
                  <Text style={s.cellText}>{row.checkedIn}</Text>
                </View>
                <View style={[s.cell, { width: W.out }]}>
                  <Text style={s.cellText}>{row.checkedOut}</Text>
                </View>
                <View style={[s.cell, { width: W.leave }]}>
                  <Text style={s.mutedText}>{row.leaveStatus}</Text>
                </View>
              </View>
            ))
          )}

          <View style={s.footer} fixed>
            <Text>
              {report.organizationName} • {report.periodLabel}
            </Text>
            <Text
              render={({ pageNumber, totalPages }) =>
                `Generated ${generatedAt} • Page ${pageNumber} of ${totalPages}`
              }
            />
          </View>
        </Page>
      ))}
    </Document>
  )
}
