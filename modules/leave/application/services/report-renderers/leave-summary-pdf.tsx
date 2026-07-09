import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer"

// ─── Types ─────────────────────────────────────────────────────────────────

export type LeaveMonthlyRow = {
  leaveTypeName: string
  entitledDays: number
  carriedDays: number
  monthly: (number | null)[]  // index 0=Jan … 11=Dec
  total: number
  balance: number
}

export type LeaveDetailRow = {
  from: string
  to: string
  leaveTypeName: string
  days: number
  reason: string | null
  attachmentName: string | null
}

export type LeaveSummaryDocumentProps = {
  organizationName: string
  employeeName: string
  year: number
  reportDate: string
  monthlyRows: LeaveMonthlyRow[]
  detailRows: LeaveDetailRow[]
}

// ─── Colours ───────────────────────────────────────────────────────────────

const C = {
  ink: "#0f172a",
  muted: "#64748b",
  faint: "#94a3b8",
  divider: "#e2e8f0",
  headerBlue: "#1e40af",
  headerText: "#ffffff",
  altRow: "#f0f9ff",
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// ─── Styles ────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 48,
    paddingHorizontal: 28,
    fontSize: 8,
    color: C.ink,
    fontFamily: "Helvetica",
  },
  headerOrg: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  headerTitle: { fontSize: 10.5, color: C.muted, marginTop: 2 },
  headerMeta: { marginTop: 5, fontSize: 8.5, color: C.muted },
  headerMetaLine: { marginTop: 2 },
  sectionTitle: { fontSize: 10, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 6 },
  divider: { borderTopWidth: 0.5, borderTopColor: C.divider, marginTop: 8, marginBottom: 8 },
  tableRow: { flexDirection: "row", borderBottomWidth: 0.4, borderBottomColor: C.divider, alignItems: "center" },
  footer: {
    position: "absolute",
    bottom: 18,
    left: 28,
    right: 28,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: C.faint,
  },
  tHeader: { fontSize: 7, fontFamily: "Helvetica-Bold", color: C.headerText },
  cell: { fontSize: 7.5, paddingVertical: 4, paddingHorizontal: 3 },
  cellRight: { fontSize: 7.5, paddingVertical: 4, paddingHorizontal: 3, textAlign: "right" },
  cellMuted: { fontSize: 7.5, paddingVertical: 4, paddingHorizontal: 3, color: C.muted },
})

function numCell(val: number | null): string {
  if (val === null || val === 0) return "–"
  return String(val)
}

// ─── Matrix table (page 1) ─────────────────────────────────────────────────

const COL_NUM = "3%"
const COL_TYPE = "14%"
const COL_ENT = "5%"
const COL_CF = "5%"
const COL_MONTH = "4.5%"   // 12 × 4.5% = 54%
const COL_TOTAL = "5%"
const COL_BAL = "5%"

function MatrixHeader() {
  return (
    <View style={[s.tableRow, { backgroundColor: C.headerBlue, borderBottomWidth: 0 }]}>
      <Text style={[s.tHeader, { width: COL_NUM, paddingVertical: 5, paddingHorizontal: 3 }]}>#</Text>
      <Text style={[s.tHeader, { width: COL_TYPE, paddingVertical: 5, paddingHorizontal: 3 }]}>Leave Type</Text>
      <Text style={[s.tHeader, { width: COL_ENT, paddingVertical: 5, paddingHorizontal: 3, textAlign: "right" }]}>Ent.</Text>
      <Text style={[s.tHeader, { width: COL_CF, paddingVertical: 5, paddingHorizontal: 3, textAlign: "right" }]}>C/F</Text>
      {MONTHS.map((m) => (
        <Text key={m} style={[s.tHeader, { width: COL_MONTH, paddingVertical: 5, paddingHorizontal: 2, textAlign: "center" }]}>{m}</Text>
      ))}
      <Text style={[s.tHeader, { width: COL_TOTAL, paddingVertical: 5, paddingHorizontal: 3, textAlign: "right" }]}>Total</Text>
      <Text style={[s.tHeader, { width: COL_BAL, paddingVertical: 5, paddingHorizontal: 3, textAlign: "right" }]}>Bal.</Text>
    </View>
  )
}

function MatrixRow({ row, index }: { row: LeaveMonthlyRow; index: number }) {
  const bg = index % 2 === 1 ? C.altRow : "#ffffff"
  return (
    <View style={[s.tableRow, { backgroundColor: bg }]}>
      <Text style={[s.cell, { width: COL_NUM, color: C.muted }]}>{index + 1}</Text>
      <Text style={[s.cell, { width: COL_TYPE, fontFamily: "Helvetica-Bold" }]}>{row.leaveTypeName}</Text>
      <Text style={[s.cellRight, { width: COL_ENT }]}>{row.entitledDays}</Text>
      <Text style={[s.cellRight, { width: COL_CF }]}>{numCell(row.carriedDays)}</Text>
      {row.monthly.map((val, i) => (
        <Text key={i} style={[s.cellMuted, { width: COL_MONTH, textAlign: "center" }]}>{numCell(val)}</Text>
      ))}
      <Text style={[s.cellRight, { width: COL_TOTAL, fontFamily: "Helvetica-Bold" }]}>{numCell(row.total)}</Text>
      <Text style={[s.cellRight, { width: COL_BAL, color: row.balance < 0 ? "#be123c" : C.ink }]}>{row.balance}</Text>
    </View>
  )
}

// ─── Detail table (page 2) ─────────────────────────────────────────────────

const D_NUM = "5%"
const D_FROM = "14%"
const D_TO = "14%"
const D_TYPE = "17%"
const D_DAYS = "7%"
const D_REASON = "29%"
const D_ATT = "14%"

function DetailHeader() {
  return (
    <View style={[s.tableRow, { backgroundColor: C.headerBlue, borderBottomWidth: 0 }]}>
      {[["#", D_NUM], ["From", D_FROM], ["To", D_TO], ["Leave Type", D_TYPE], ["Days", D_DAYS], ["Reason", D_REASON], ["Attachment", D_ATT]].map(([label, w]) => (
        <Text key={label} style={[s.tHeader, { width: w, paddingVertical: 5, paddingHorizontal: 4 }]}>{label}</Text>
      ))}
    </View>
  )
}

function DetailRow({ row, index }: { row: LeaveDetailRow; index: number }) {
  const bg = index % 2 === 1 ? C.altRow : "#ffffff"
  return (
    <View style={[s.tableRow, { backgroundColor: bg }]}>
      <Text style={[s.cell, { width: D_NUM, color: C.muted }]}>{index + 1}</Text>
      <Text style={[s.cell, { width: D_FROM }]}>{row.from}</Text>
      <Text style={[s.cell, { width: D_TO }]}>{row.to}</Text>
      <Text style={[s.cell, { width: D_TYPE }]}>{row.leaveTypeName}</Text>
      <Text style={[s.cell, { width: D_DAYS, textAlign: "right" }]}>{row.days}</Text>
      <Text style={[s.cell, { width: D_REASON, color: row.reason ? C.ink : C.muted }]}>{row.reason ?? "—"}</Text>
      <Text style={[s.cell, { width: D_ATT, color: row.attachmentName ? C.ink : C.muted }]}>{row.attachmentName ?? "—"}</Text>
    </View>
  )
}

// ─── Document ──────────────────────────────────────────────────────────────

export function LeaveSummaryDocument(props: LeaveSummaryDocumentProps) {
  const { organizationName, employeeName, year, reportDate, monthlyRows, detailRows } = props

  return (
    <Document title={`Leave Summary ${year}`} author={organizationName}>
      {/* Page 1: Matrix */}
      <Page size="A4" orientation="landscape" style={s.page}>
        <Text style={s.headerOrg}>{organizationName}</Text>
        <Text style={s.headerTitle}>YEARLY LEAVE SUMMARY – {year}</Text>
        <View style={s.headerMeta}>
          <Text style={s.headerMetaLine}>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>Employee: </Text>
            {employeeName}
          </Text>
          <Text style={s.headerMetaLine}>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>Report Date: </Text>
            {reportDate}
          </Text>
        </View>
        <View style={s.divider} />
        <MatrixHeader />
        {monthlyRows.map((row, i) => (
          <MatrixRow key={row.leaveTypeName} row={row} index={i} />
        ))}
        {monthlyRows.length === 0 ? (
          <Text style={[s.cell, { color: C.muted, marginTop: 12 }]}>No leave entitlements for this year.</Text>
        ) : null}
        <View style={s.footer} fixed>
          <Text>Generated on {reportDate}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
        </View>
      </Page>

      {/* Page 2: Detail */}
      <Page size="A4" orientation="landscape" style={s.page}>
        <Text style={s.headerOrg}>{organizationName}</Text>
        <Text style={s.headerTitle}>YEARLY LEAVE SUMMARY – {year}  |  Leave Applications</Text>
        <View style={s.headerMeta}>
          <Text style={s.headerMetaLine}>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>Employee: </Text>
            {employeeName}
          </Text>
        </View>
        <View style={s.divider} />
        <DetailHeader />
        {detailRows.map((row, i) => (
          <DetailRow key={i} row={row} index={i} />
        ))}
        {detailRows.length === 0 ? (
          <Text style={[s.cell, { color: C.muted, marginTop: 12 }]}>No approved leave applications for {year}.</Text>
        ) : null}
        <View style={s.footer} fixed>
          <Text>Generated on {reportDate}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  )
}

// ─── Bulk variant ──────────────────────────────────────────────────────────

export function LeaveSummaryBulkDocument(props: {
  sections: LeaveSummaryDocumentProps[]
}) {
  return (
    <Document title="Leave Summary" author="">
      {props.sections.flatMap((section, sIdx) => [
        // Matrix page
        <Page key={`${sIdx}-matrix`} size="A4" orientation="landscape" style={s.page}>
          <Text style={s.headerOrg}>{section.organizationName}</Text>
          <Text style={s.headerTitle}>YEARLY LEAVE SUMMARY – {section.year}</Text>
          <View style={s.headerMeta}>
            <Text style={s.headerMetaLine}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Employee: </Text>
              {section.employeeName}
            </Text>
            <Text style={s.headerMetaLine}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Report Date: </Text>
              {section.reportDate}
            </Text>
          </View>
          <View style={s.divider} />
          <MatrixHeader />
          {section.monthlyRows.map((row, i) => (
            <MatrixRow key={row.leaveTypeName} row={row} index={i} />
          ))}
          {section.monthlyRows.length === 0 ? (
            <Text style={[s.cell, { color: C.muted, marginTop: 12 }]}>No leave entitlements for this year.</Text>
          ) : null}
          <View style={s.footer} fixed>
            <Text>Generated on {section.reportDate}</Text>
            <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
          </View>
        </Page>,
        // Detail page
        <Page key={`${sIdx}-detail`} size="A4" orientation="landscape" style={s.page}>
          <Text style={s.headerOrg}>{section.organizationName}</Text>
          <Text style={s.headerTitle}>YEARLY LEAVE SUMMARY – {section.year}  |  Leave Applications</Text>
          <View style={s.headerMeta}>
            <Text style={s.headerMetaLine}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Employee: </Text>
              {section.employeeName}
            </Text>
          </View>
          <View style={s.divider} />
          <DetailHeader />
          {section.detailRows.map((row, i) => (
            <DetailRow key={i} row={row} index={i} />
          ))}
          {section.detailRows.length === 0 ? (
            <Text style={[s.cell, { color: C.muted, marginTop: 12 }]}>No approved leave applications for {section.year}.</Text>
          ) : null}
          <View style={s.footer} fixed>
            <Text>Generated on {section.reportDate}</Text>
            <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`} />
          </View>
        </Page>,
      ])}
    </Document>
  )
}
