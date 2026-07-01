/**
 * Real PDF document for the payroll summary, generated via
 * `@react-pdf/renderer`. Returns a stream of properly-laid-out PDF
 * pages — NOT a screenshot of the on-screen table.
 *
 * Layout follows the reference design `Payroll_Summary_<Month_Year>.pdf`:
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ EVERGROWTH CONSULTING SDN. BHD. (FKA …) (BRN)            │
 *   │ Payroll Jan 01 2026 – Jan 31 2026                         │
 *   │                                                           │
 *   │              Employee contributions    Employer contributions │
 *   │ Employee │ GROSS │ PCB EPF SOCSO EIS SKBBK │ NET │ EPF SOCSO EIS HRDF │ COST │
 *   │  Total   │ 56,k  │ 705 …             │ 49k │ 7.2k …             │ 65k  │
 *   ├───────────┼───────┼───────────────────┼─────┼────────────────────┼──────┤
 *   │ Alan Lau Zi Hong   3,000   …                                     │
 *   │   Base salary         2,500                                      │
 *   │   Other Allowance     + 250 (green)                              │
 *   │   …                                                              │
 *   ├───────────┴───────┴───────────────────┴─────┴────────────────────┴──────┤
 *   │ Summary footer                                                        │
 *   └───────────────────────────────────────────────────────────────────────┘
 *
 * The document is generated server-side from `PayslipRow[]` so it
 * looks identical regardless of the user's browser / display.
 */

import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer"

import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"
import type { PayslipRow } from "@/modules/payroll/domain/runs"

/**
 * True when the line item is a non-cash BIK / perquisite. These rows
 * are listed for tax transparency but do NOT add into gross pay — the
 * breakdown column flags them so the admin doesn't expect the numbers
 * to sum to grossPay.
 */
function isNonCashLineItem(category: string | null | undefined): boolean {
  if (!category) return false
  const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[category as PayrollAdjustmentCategory]
  return Boolean(meta?.nonCash)
}

// ─── Colours ────────────────────────────────────────────────────────────

const COLOURS = {
  ink: "#0f172a", // slate-900
  muted: "#64748b", // slate-500
  faint: "#94a3b8", // slate-400
  divider: "#e2e8f0", // slate-200
  rule: "#cbd5e1", // slate-300
  empBand: "#0e7490", // cyan-700
  empBandBg: "#ecfeff", // cyan-50
  empBandUnderline: "#67e8f9", // cyan-300
  erBand: "#c2410c", // orange-700
  erBandBg: "#fff7ed", // orange-50
  erBandUnderline: "#fdba74", // orange-300
  positive: "#047857", // emerald-700
  negative: "#be123c", // rose-700
}

// ─── Column layout ──────────────────────────────────────────────────────
//
// Widths are expressed in flex units. A3 landscape minus margins is
// ~1140pt wide; with these flex values each row balances at a
// comfortable reading width. The Employee column gets the most space
// so even long names ("Henry Ariapala A/L M.Ariapala") fit on one
// line without truncation.

const COL = {
  employee: 4.2,
  gross: 1.05,
  pcb: 0.95,
  epfEmp: 1.0,
  socsoEmp: 0.95,
  eisEmp: 0.85,
  skbbkEmp: 0.85,
  net: 1.1,
  epfEr: 1.0,
  socsoEr: 0.95,
  eisEr: 0.85,
  hrdf: 0.85,
  cost: 1.15,
}

// ─── Styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  page: {
    paddingTop: 32,
    paddingBottom: 28,
    paddingHorizontal: 28,
    fontSize: 8.5,
    color: COLOURS.ink,
    fontFamily: "Helvetica",
  },
  // ── Header
  headerCompany: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.ink,
  },
  headerPeriod: {
    marginTop: 2,
    fontSize: 9.5,
    color: COLOURS.muted,
  },
  // ── Column-group banner row
  bandRow: {
    flexDirection: "row",
    marginTop: 12,
  },
  bandSpacer: {
    // The "Hours" / GROSS / NET / COST columns sit between the
    // tinted bands. Bordered transparently so the band underlines
    // still line up with the column edges.
  },
  bandEmp: {
    flexDirection: "row",
    justifyContent: "center",
    paddingBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: COLOURS.empBandUnderline,
    backgroundColor: COLOURS.empBandBg,
  },
  bandEr: {
    flexDirection: "row",
    justifyContent: "center",
    paddingBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: COLOURS.erBandUnderline,
    backgroundColor: COLOURS.erBandBg,
  },
  bandText: {
    fontSize: 7.5,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  bandTextEmp: { color: COLOURS.empBand },
  bandTextEr: { color: COLOURS.erBand },
  // ── Column header row (labels + totals)
  headerRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: COLOURS.rule,
    paddingTop: 4,
    paddingBottom: 6,
  },
  headerCell: {
    paddingHorizontal: 3,
  },
  headerCellRight: {
    paddingHorizontal: 3,
    alignItems: "flex-end",
  },
  headerLabel: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.muted,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  headerTotal: {
    marginTop: 1.5,
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.ink,
  },
  // ── Body rows
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: COLOURS.divider,
    paddingVertical: 5,
  },
  cell: {
    paddingHorizontal: 3,
  },
  cellRight: {
    paddingHorizontal: 3,
    alignItems: "flex-end",
  },
  cellEmpTinted: {
    paddingHorizontal: 3,
    alignItems: "flex-end",
    backgroundColor: COLOURS.empBandBg,
  },
  cellErTinted: {
    paddingHorizontal: 3,
    alignItems: "flex-end",
    backgroundColor: COLOURS.erBandBg,
  },
  empName: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.ink,
  },
  empMeta: {
    marginTop: 1,
    fontSize: 7.5,
    color: COLOURS.muted,
  },
  breakdownLine: {
    marginTop: 2,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
  },
  breakdownLabel: {
    color: COLOURS.muted,
    flexGrow: 1,
  },
  breakdownAmount: {
    fontFamily: "Helvetica",
  },
  breakdownPositive: {
    color: COLOURS.positive,
  },
  breakdownNegative: {
    color: COLOURS.negative,
  },
  amount: {
    fontFamily: "Helvetica",
    fontSize: 8.5,
  },
  amountBold: {
    fontFamily: "Helvetica-Bold",
    fontSize: 8.5,
  },
  dim: {
    color: COLOURS.faint,
  },
  // ── Footer (summary block)
  summaryWrap: {
    marginTop: 14,
    flexDirection: "row",
    flexWrap: "wrap",
    rowGap: 4,
  },
  summaryRow: {
    width: "33.3333%",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  summaryLabel: {
    fontSize: 8,
    color: COLOURS.muted,
  },
  summaryValue: {
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.ink,
  },
  // ── Page footer (running on every sheet)
  pageFooter: {
    position: "absolute",
    bottom: 14,
    left: 28,
    right: 28,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: COLOURS.faint,
  },
})

// ─── Format helpers ─────────────────────────────────────────────────────

function fmt(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "—"
  return value.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtSigned(value: number): string {
  const sign = value < 0 ? "− " : "+ "
  return (
    sign +
    Math.abs(value).toLocaleString("en-MY", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  )
}

// ─── Document ───────────────────────────────────────────────────────────

export type PayrollSummaryPdfProps = {
  organizationName: string
  period: string // e.g. "January 2025"
  payslips: PayslipRow[]
  generatedAt?: Date
}

export function PayrollSummaryPdfDocument({
  organizationName,
  period,
  payslips,
  generatedAt = new Date(),
}: PayrollSummaryPdfProps) {
  // Run-level totals (employer + employee + everything) computed once
  // up-front so we can render them as header-cell sub-totals (matching
  // the reference design) and again in the summary block at the foot.
  const totals = payslips.reduce(
    (acc, p) => {
      acc.gross += p.grossPay
      acc.bik += p.totalBenefitsInKind
      acc.pcb += p.pcb
      acc.epfEmp += p.epfEmployee
      acc.socsoEmp += p.socsoEmployee
      acc.eisEmp += p.eisEmployee
      acc.skbbkEmp += p.skbbkEmployee
      acc.net += p.netPay
      acc.epfEr += p.epfEmployer
      acc.socsoEr += p.socsoEmployer
      acc.eisEr += p.eisEmployer
      acc.hrdf += p.hrdf
      acc.cost += p.totalCostToEmployer
      acc.zakat += p.zakat
      acc.hrdfWage += p.hrdfWage
      if (p.hrdf > 0) acc.hrdfCount += 1
      return acc
    },
    {
      gross: 0,
      bik: 0,
      pcb: 0,
      epfEmp: 0,
      socsoEmp: 0,
      eisEmp: 0,
      skbbkEmp: 0,
      net: 0,
      epfEr: 0,
      socsoEr: 0,
      eisEr: 0,
      hrdf: 0,
      cost: 0,
      zakat: 0,
      hrdfWage: 0,
      hrdfCount: 0,
    },
  )

  return (
    <Document
      title={`${organizationName} Payroll ${period}`}
      author={organizationName}
      subject={`Payroll summary — ${period}`}
    >
      <Page size="A3" orientation="landscape" style={styles.page} wrap>
        {/* ── Document header ─────────────────────────────────── */}
        <View>
          <Text style={styles.headerCompany}>{organizationName}</Text>
          <Text style={styles.headerPeriod}>Payroll {period}</Text>
        </View>

        {/* ── Column-group banner row ─────────────────────────── */}
        <View style={styles.bandRow}>
          {/* Employee column spacer */}
          <View
            style={[styles.bandSpacer, { flex: COL.employee + COL.gross }]}
          />
          {/* Employee contributions band — spans PCB + EPF + SOCSO
              + EIS + SKBBK. SKBBK (Skim LINDUNG 24 Jam) is an
              employee-only PERKESO scheme effective 1 Jun 2026. */}
          <View
            style={[
              styles.bandEmp,
              {
                flex:
                  COL.pcb +
                  COL.epfEmp +
                  COL.socsoEmp +
                  COL.eisEmp +
                  COL.skbbkEmp,
              },
            ]}
          >
            <Text style={[styles.bandText, styles.bandTextEmp]}>
              Employee contributions
            </Text>
          </View>
          {/* NET spacer */}
          <View style={[styles.bandSpacer, { flex: COL.net }]} />
          {/* Employer contributions band */}
          <View
            style={[
              styles.bandEr,
              {
                flex: COL.epfEr + COL.socsoEr + COL.eisEr + COL.hrdf,
              },
            ]}
          >
            <Text style={[styles.bandText, styles.bandTextEr]}>
              Employer contributions
            </Text>
          </View>
          {/* COST spacer */}
          <View style={[styles.bandSpacer, { flex: COL.cost }]} />
        </View>

        {/* ── Column heading + totals row ─────────────────────── */}
        <View style={styles.headerRow} fixed>
          <View style={[styles.headerCell, { flex: COL.employee }]}>
            <Text style={styles.headerLabel}>Employee Name</Text>
          </View>
          <ColHead label="GROSS" total={totals.gross} flex={COL.gross} />
          <ColHead label="PCB" total={totals.pcb} flex={COL.pcb} tint="emp" />
          <ColHead label="EPF" total={totals.epfEmp} flex={COL.epfEmp} tint="emp" />
          <ColHead
            label="SOCSO"
            total={totals.socsoEmp}
            flex={COL.socsoEmp}
            tint="emp"
          />
          <ColHead label="EIS" total={totals.eisEmp} flex={COL.eisEmp} tint="emp" />
          <ColHead
            label="SKBBK"
            total={totals.skbbkEmp}
            flex={COL.skbbkEmp}
            tint="emp"
          />
          <ColHead label="NET" total={totals.net} flex={COL.net} bold />
          <ColHead label="EPF" total={totals.epfEr} flex={COL.epfEr} tint="er" />
          <ColHead
            label="SOCSO"
            total={totals.socsoEr}
            flex={COL.socsoEr}
            tint="er"
          />
          <ColHead label="EIS" total={totals.eisEr} flex={COL.eisEr} tint="er" />
          <ColHead label="HRDF" total={totals.hrdf} flex={COL.hrdf} tint="er" />
          <ColHead label="COST" total={totals.cost} flex={COL.cost} bold />
        </View>

        {/* ── Body rows ───────────────────────────────────────── */}
        {payslips.map((p) => (
          <PayslipBodyRow key={p.id} payslip={p} />
        ))}

        {/* ── Summary footer ──────────────────────────────────── */}
        <View style={styles.summaryWrap} wrap={false}>
          <SummaryRow
            label="Number of employees"
            value={String(payslips.length)}
          />
          <SummaryRow label="Total employee net pay" value={fmt(totals.net)} />
          <SummaryRow label="Total PCB payment" value={fmt(totals.pcb)} />
          <SummaryRow
            label="Employees subject to HRDF"
            value={String(totals.hrdfCount)}
          />
          <SummaryRow
            label="Total wages subject to HRDF"
            value={fmt(totals.hrdfWage)}
          />
          <SummaryRow
            label="Total EPF payment"
            value={fmt(totals.epfEmp + totals.epfEr)}
          />
          <SummaryRow
            label="Total SOCSO payment"
            value={fmt(totals.socsoEmp + totals.socsoEr)}
          />
          <SummaryRow
            label="Total EIS payment"
            value={fmt(totals.eisEmp + totals.eisEr)}
          />
          {/* SKBBK (Skim LINDUNG 24 Jam) — employee-only PERKESO
              scheme, effective 1 Jun 2026. Hidden when 0 so periods
              before June 2026 don't show a junk RM 0.00 line. */}
          {totals.skbbkEmp > 0 ? (
            <SummaryRow
              label="Total SKBBK payment"
              value={fmt(totals.skbbkEmp)}
            />
          ) : null}
          <SummaryRow label="Total HRDF payment" value={fmt(totals.hrdf)} />
          <SummaryRow label="Total Zakat payment" value={fmt(totals.zakat)} />
          {totals.bik > 0 ? (
            <SummaryRow
              label="Total Benefits in Kind (non-cash, for tax)"
              value={fmt(totals.bik)}
            />
          ) : null}
        </View>

        {/* ── Running page footer ─────────────────────────────── */}
        <View style={styles.pageFooter} fixed>
          <Text>{`${organizationName} · Payroll ${period}`}</Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages} · Generated ${generatedAt
                .toLocaleString("en-MY", {
                  dateStyle: "short",
                  timeStyle: "short",
                })
                .replace(",", "")}`
            }
          />
        </View>
      </Page>
    </Document>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────

function ColHead({
  label,
  total,
  flex,
  tint,
  bold,
}: {
  label: string
  total: number
  flex: number
  tint?: "emp" | "er"
  bold?: boolean
}) {
  return (
    <View
      style={[
        styles.headerCellRight,
        { flex },
        tint === "emp" ? { backgroundColor: COLOURS.empBandBg } : {},
        tint === "er" ? { backgroundColor: COLOURS.erBandBg } : {},
      ]}
    >
      <Text style={styles.headerLabel}>{label}</Text>
      <Text style={[styles.headerTotal, bold ? styles.amountBold : {}]}>
        {fmt(total)}
      </Text>
    </View>
  )
}

function PayslipBodyRow({ payslip }: { payslip: PayslipRow }) {
  // Build the breakdown the same way the on-screen table does: base
  // salary, OT pay (with hour breakdown), and each line item with
  // sign-coloured amount.
  const breakdown: Array<{ label: string; amount: number; signed: boolean }> =
    []
  if (payslip.proratedPay > 0) {
    breakdown.push({
      label: "Base salary",
      amount: payslip.proratedPay,
      signed: false,
    })
  }
  if (payslip.otPay > 0) {
    const parts: string[] = []
    if (payslip.otNormalHours > 0)
      parts.push(`${payslip.otNormalHours} normal`)
    if (payslip.otRestHours > 0) parts.push(`${payslip.otRestHours} rest`)
    if (payslip.otPublicHours > 0)
      parts.push(`${payslip.otPublicHours} PH`)
    const tail = parts.length ? ` (${parts.join(" + ")})` : ""
    breakdown.push({
      label: `Overtime${tail}`,
      amount: payslip.otPay,
      signed: true,
    })
  }
  for (const li of payslip.lineItems) {
    // BIK / perquisite rows are non-cash — they don't add to gross.
    // Tag them and render without a sign so the admin sees they're
    // disclosure-only, not part of the gross math.
    const nonCash = li.kind === "ALLOWANCE" && isNonCashLineItem(li.category)
    if (nonCash) {
      breakdown.push({
        label: `${li.label} (BIK · non-cash)`,
        amount: li.amount,
        signed: false,
      })
      continue
    }
    const sign = li.kind === "DEDUCTION" ? -1 : 1
    breakdown.push({
      label: li.label,
      amount: sign * li.amount,
      signed: true,
    })
  }

  return (
    <View style={styles.row} wrap={false}>
      <View style={[styles.cell, { flex: COL.employee }]}>
        <Text style={styles.empName}>{payslip.snapshotName}</Text>
        <Text style={styles.empMeta}>
          {payslip.snapshotEmployeeId}
          {payslip.snapshotPosition ? ` · ${payslip.snapshotPosition}` : ""}
        </Text>
        {breakdown.map((it, i) => (
          <View
            key={`${payslip.id}-${i}`}
            style={styles.breakdownLine}
          >
            <Text style={styles.breakdownLabel}>{it.label}</Text>
            <Text
              style={[
                styles.breakdownAmount,
                it.signed && it.amount > 0 ? styles.breakdownPositive : {},
                it.signed && it.amount < 0 ? styles.breakdownNegative : {},
              ]}
            >
              {it.signed
                ? fmtSigned(it.amount)
                : it.amount.toLocaleString("en-MY", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
            </Text>
          </View>
        ))}
      </View>
      <AmountCell value={payslip.grossPay} flex={COL.gross} bold />
      <AmountCell value={payslip.pcb} flex={COL.pcb} tint="emp" />
      <AmountCell value={payslip.epfEmployee} flex={COL.epfEmp} tint="emp" />
      <AmountCell value={payslip.socsoEmployee} flex={COL.socsoEmp} tint="emp" />
      <AmountCell value={payslip.eisEmployee} flex={COL.eisEmp} tint="emp" />
      <AmountCell
        value={payslip.skbbkEmployee}
        flex={COL.skbbkEmp}
        tint="emp"
      />
      <AmountCell value={payslip.netPay} flex={COL.net} bold />
      <AmountCell value={payslip.epfEmployer} flex={COL.epfEr} tint="er" />
      <AmountCell value={payslip.socsoEmployer} flex={COL.socsoEr} tint="er" />
      <AmountCell value={payslip.eisEmployer} flex={COL.eisEr} tint="er" />
      <AmountCell value={payslip.hrdf} flex={COL.hrdf} tint="er" />
      <AmountCell value={payslip.totalCostToEmployer} flex={COL.cost} bold />
    </View>
  )
}

function AmountCell({
  value,
  flex,
  tint,
  bold,
}: {
  value: number
  flex: number
  tint?: "emp" | "er"
  bold?: boolean
}) {
  return (
    <View
      style={[
        styles.cellRight,
        { flex },
        tint === "emp" ? { backgroundColor: COLOURS.empBandBg } : {},
        tint === "er" ? { backgroundColor: COLOURS.erBandBg } : {},
      ]}
    >
      <Text
        style={[bold ? styles.amountBold : styles.amount, value === 0 ? styles.dim : {}]}
      >
        {fmt(value)}
      </Text>
    </View>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  )
}
