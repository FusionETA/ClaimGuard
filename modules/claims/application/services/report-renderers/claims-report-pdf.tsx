import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer"

/// React-PDF document for the admin claims flat-list report.
/// A4 landscape — 7 data columns (Employee / Project / Claim /
/// Account / Spent / Amount / Status) plus a totals footer.

export type ClaimsReportRow = {
  claimNumber: string
  title: string
  employeeName: string
  employeeEmail: string
  project: string
  accountCode: string
  accountName: string
  amount: number
  currency: string
  spentOn: string // yyyy-mm-dd
  status: string
  payrollLabel: string | null
  xeroSyncLabel: string
}

export type ClaimsReportDocumentProps = {
  organizationName: string
  resolvedFrom: string // yyyy-mm-dd
  resolvedTo: string   // yyyy-mm-dd
  filterSummary: string | null
  rows: ClaimsReportRow[]
  totalCount: number
  totalAmount: number
  currency: string
  generatedAt: Date
}

const C = {
  ink: "#0f172a",
  muted: "#64748b",
  faint: "#94a3b8",
  divider: "#e2e8f0",
  headerBg: "#1f3a5f",
  headerFg: "#ffffff",
  altRow: "#f8fafc",
}

const s = StyleSheet.create({
  page: {
    paddingTop: 32,
    paddingBottom: 42,
    paddingHorizontal: 32,
    fontSize: 9,
    color: C.ink,
    fontFamily: "Helvetica",
  },
  headerOrg: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  headerTitle: { fontSize: 10.5, color: C.muted, marginTop: 2 },
  headerMeta: { fontSize: 8.5, color: C.muted, marginTop: 6, lineHeight: 1.35 },
  divider: {
    borderTopWidth: 0.5,
    borderTopColor: C.divider,
    marginTop: 10,
    marginBottom: 8,
  },
  summaryRow: {
    flexDirection: "row",
    gap: 24,
    marginBottom: 10,
    marginTop: 2,
  },
  summaryCard: {
    borderWidth: 0.5,
    borderColor: C.divider,
    borderRadius: 3,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 130,
  },
  summaryLabel: {
    fontSize: 7.5,
    color: C.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  summaryValue: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    marginTop: 2,
  },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: C.headerBg,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  tableHeaderText: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: C.headerFg,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 0.25,
    borderBottomColor: C.divider,
    paddingVertical: 5,
    paddingHorizontal: 4,
  },
  cell: {
    paddingRight: 6,
    fontSize: 8.5,
  },
  cellMuted: {
    fontSize: 8,
    color: C.muted,
    marginTop: 1,
  },
  cellRight: { textAlign: "right" },
  colEmployee: { width: "16%" },
  colProject: { width: "13%" },
  colClaim: { width: "22%" },
  colAccount: { width: "16%" },
  colSpent: { width: "9%" },
  colAmount: { width: "11%" },
  colStatus: { width: "13%" },
  totalsRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: C.ink,
    paddingTop: 6,
    marginTop: 4,
  },
  totalsLabel: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: C.ink,
  },
  totalsValue: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    color: C.ink,
    textAlign: "right",
  },
  emptyState: {
    marginTop: 24,
    marginBottom: 24,
    textAlign: "center",
    color: C.muted,
    fontSize: 10,
  },
  footer: {
    position: "absolute",
    bottom: 18,
    left: 32,
    right: 32,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: C.faint,
  },
})

function fmtDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number)
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ]
  if (!y || !m || !d) return dateStr
  return `${d} ${months[m - 1]} ${y}`
}

function fmtAmount(amount: number, currency: string): string {
  const n = Math.round(amount * 100) / 100
  return `${currency} ${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function fmtGenerated(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function TableHeader() {
  return (
    <View style={s.tableHeaderRow} fixed>
      <View style={s.colEmployee}>
        <Text style={s.tableHeaderText}>Employee</Text>
      </View>
      <View style={s.colProject}>
        <Text style={s.tableHeaderText}>Project</Text>
      </View>
      <View style={s.colClaim}>
        <Text style={s.tableHeaderText}>Claim</Text>
      </View>
      <View style={s.colAccount}>
        <Text style={s.tableHeaderText}>Account</Text>
      </View>
      <View style={s.colSpent}>
        <Text style={s.tableHeaderText}>Spent</Text>
      </View>
      <View style={s.colAmount}>
        <Text style={[s.tableHeaderText, s.cellRight]}>Amount</Text>
      </View>
      <View style={s.colStatus}>
        <Text style={s.tableHeaderText}>Status</Text>
      </View>
    </View>
  )
}

export function ClaimsReportDocument(props: ClaimsReportDocumentProps) {
  const {
    organizationName,
    resolvedFrom,
    resolvedTo,
    filterSummary,
    rows,
    totalCount,
    totalAmount,
    currency,
    generatedAt,
  } = props

  return (
    <Document
      title={`Claims Report ${resolvedFrom} to ${resolvedTo}`}
      author={organizationName}
    >
      <Page size="A4" orientation="landscape" style={s.page}>
        <Text style={s.headerOrg}>{organizationName}</Text>
        <Text style={s.headerTitle}>Claims report</Text>
        <Text style={s.headerMeta}>
          Period: {fmtDate(resolvedFrom)} → {fmtDate(resolvedTo)}
          {filterSummary ? `\nFilters: ${filterSummary}` : ""}
        </Text>

        <View style={s.divider} />

        <View style={s.summaryRow}>
          <View style={s.summaryCard}>
            <Text style={s.summaryLabel}>Matching claims</Text>
            <Text style={s.summaryValue}>{totalCount.toLocaleString()}</Text>
          </View>
          <View style={s.summaryCard}>
            <Text style={s.summaryLabel}>Total amount</Text>
            <Text style={s.summaryValue}>
              {fmtAmount(totalAmount, currency)}
            </Text>
          </View>
        </View>

        <TableHeader />

        {rows.length === 0 ? (
          <Text style={s.emptyState}>
            No claims match the selected filters.
          </Text>
        ) : (
          rows.map((r, i) => (
            <View
              key={r.claimNumber + i}
              style={[
                s.tableRow,
                i % 2 === 1 ? { backgroundColor: C.altRow } : {},
              ]}
              wrap={false}
            >
              <View style={s.colEmployee}>
                <Text style={s.cell}>{r.employeeName || "—"}</Text>
                {r.employeeEmail ? (
                  <Text style={s.cellMuted}>{r.employeeEmail}</Text>
                ) : null}
              </View>
              <View style={s.colProject}>
                <Text style={s.cell}>{r.project || "—"}</Text>
              </View>
              <View style={s.colClaim}>
                <Text style={s.cell}>{r.title || "—"}</Text>
                <Text style={s.cellMuted}>{r.claimNumber}</Text>
              </View>
              <View style={s.colAccount}>
                <Text style={s.cell}>{r.accountName || "—"}</Text>
                {r.accountCode ? (
                  <Text style={s.cellMuted}>{r.accountCode}</Text>
                ) : null}
              </View>
              <View style={s.colSpent}>
                <Text style={s.cell}>{fmtDate(r.spentOn)}</Text>
              </View>
              <View style={s.colAmount}>
                <Text style={[s.cell, s.cellRight]}>
                  {fmtAmount(r.amount, r.currency)}
                </Text>
              </View>
              <View style={s.colStatus}>
                <Text style={s.cell}>{r.status}</Text>
                {r.payrollLabel ? (
                  <Text style={s.cellMuted}>Payroll: {r.payrollLabel}</Text>
                ) : null}
                {r.xeroSyncLabel && r.xeroSyncLabel !== "Not synced" ? (
                  <Text style={s.cellMuted}>Xero: {r.xeroSyncLabel}</Text>
                ) : null}
              </View>
            </View>
          ))
        )}

        {rows.length > 0 ? (
          <View style={s.totalsRow}>
            <View style={s.colEmployee}>
              <Text style={s.totalsLabel}>Total ({totalCount})</Text>
            </View>
            <View style={s.colProject} />
            <View style={s.colClaim} />
            <View style={s.colAccount} />
            <View style={s.colSpent} />
            <View style={s.colAmount}>
              <Text style={s.totalsValue}>
                {fmtAmount(totalAmount, currency)}
              </Text>
            </View>
            <View style={s.colStatus} />
          </View>
        ) : null}

        <View style={s.footer} fixed>
          <Text>
            {organizationName} · Generated {fmtGenerated(generatedAt)}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `${pageNumber} / ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  )
}
