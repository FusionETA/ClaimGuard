/**
 * Three additional payroll-run PDF documents, rendered server-side via
 * `@react-pdf/renderer`:
 *
 *   1. `PaymentSchedulePdfDocument`
 *      — Per-employee net amounts + statutory remittance totals.
 *
 *   2. `PcbCalculationDetailsPdfDocument`
 *      — LHDN MTD §E worksheet for each employee (dark-navy header,
 *        numbered sections PCB(A) / PCB(B) / PCB(C), official LHDN
 *        variable descriptions). Audit-ready. Superseded the older
 *        compact "Detailed Calculations" PDF in 2026-06.
 *
 *   3. `BulkPayslipsPdfDocument`
 *      — One payslip page per employee, concatenated into a single PDF.
 *
 * Styling matches the existing `PayrollSummaryPdfDocument` so the
 * documents feel like a set. Keep visual changes additive — admin
 * shouldn't have to re-learn the layout when we tweak a column.
 */

import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer"

import type { PayslipRow } from "@/modules/payroll/domain/runs"

// ─── Colours / typography ──────────────────────────────────────────────

const COLOURS = {
  ink: "#0f172a",
  muted: "#64748b",
  faint: "#94a3b8",
  divider: "#e2e8f0",
  rule: "#cbd5e1",
  panelBg: "#f8fafc",
  positive: "#047857",
  negative: "#be123c",
}

const baseStyles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 36,
    paddingHorizontal: 40,
    fontSize: 9,
    color: COLOURS.ink,
    fontFamily: "Helvetica",
  },
  headerOrg: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.ink,
  },
  headerSub: {
    marginTop: 2,
    fontSize: 9.5,
    color: COLOURS.muted,
  },
  sectionTitle: {
    marginTop: 18,
    marginBottom: 8,
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
  },
  row: { flexDirection: "row" },
  rowLine: {
    flexDirection: "row",
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOURS.divider,
  },
  cellLabel: { flex: 3 },
  cellAmount: { flex: 1, textAlign: "right" },
  totalRow: {
    flexDirection: "row",
    paddingTop: 6,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: COLOURS.rule,
  },
  totalLabel: { flex: 3, fontFamily: "Helvetica-Bold" },
  totalAmount: {
    flex: 1,
    textAlign: "right",
    fontFamily: "Helvetica-Bold",
  },
  faintNote: {
    marginTop: 4,
    fontSize: 8,
    color: COLOURS.faint,
  },
  footer: {
    position: "absolute",
    bottom: 18,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: COLOURS.faint,
  },
})

function fmtMyr(v: number | null | undefined): string {
  const n = v ?? 0
  return new Intl.NumberFormat("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

// ─── 1. Payment Schedule ────────────────────────────────────────────────

export type PaymentSchedulePdfDocumentProps = {
  organizationName: string
  period: string
  payslips: PayslipRow[]
  totals: {
    pcb: number
    epfEmployee: number
    epfEmployer: number
    socsoEmployee: number
    socsoEmployer: number
    eisEmployee: number
    eisEmployer: number
    hrdf: number
  }
  generatedAt: Date
}

export function PaymentSchedulePdfDocument(
  props: PaymentSchedulePdfDocumentProps,
) {
  const epfTotal = props.totals.epfEmployee + props.totals.epfEmployer
  const socsoTotal = props.totals.socsoEmployee + props.totals.socsoEmployer
  const eisTotal = props.totals.eisEmployee + props.totals.eisEmployer
  const netTotal = props.payslips.reduce((s, p) => s + p.netPay, 0)

  return (
    <Document
      title={`Payment Schedule ${props.period}`}
      author={props.organizationName}
    >
      <Page size="A4" style={baseStyles.page}>
        <View>
          <Text style={baseStyles.headerOrg}>{props.organizationName}</Text>
          <Text style={baseStyles.headerSub}>
            Payment schedule · {props.period}
          </Text>
        </View>

        <Text style={baseStyles.sectionTitle}>Pay Employees</Text>
        {props.payslips.map((p) => (
          <View key={p.id} style={baseStyles.rowLine}>
            <Text style={baseStyles.cellLabel}>
              {p.snapshotName}{" "}
              <Text style={{ color: COLOURS.muted }}>
                · {p.snapshotEmployeeId}
              </Text>
            </Text>
            <Text style={baseStyles.cellAmount}>{fmtMyr(p.netPay)}</Text>
          </View>
        ))}
        <View style={baseStyles.totalRow}>
          <Text style={baseStyles.totalLabel}>Total employee net pay</Text>
          <Text style={baseStyles.totalAmount}>{fmtMyr(netTotal)}</Text>
        </View>

        <Text style={baseStyles.sectionTitle}>Other Payments</Text>
        <View style={baseStyles.rowLine}>
          <Text style={baseStyles.cellLabel}>
            Lembaga Hasil Dalam Negeri (PCB / MTD)
          </Text>
          <Text style={baseStyles.cellAmount}>
            {fmtMyr(props.totals.pcb)}
          </Text>
        </View>
        <View style={baseStyles.rowLine}>
          <Text style={baseStyles.cellLabel}>
            Kumpulan Wang Simpanan Pekerja (EPF) — Employee
          </Text>
          <Text style={baseStyles.cellAmount}>
            {fmtMyr(props.totals.epfEmployee)}
          </Text>
        </View>
        <View style={baseStyles.rowLine}>
          <Text style={baseStyles.cellLabel}>
            Kumpulan Wang Simpanan Pekerja (EPF) — Employer
          </Text>
          <Text style={baseStyles.cellAmount}>
            {fmtMyr(props.totals.epfEmployer)}
          </Text>
        </View>
        <View style={baseStyles.rowLine}>
          <Text style={baseStyles.cellLabel}>
            Pertubuhan Keselamatan Sosial (SOCSO) — Employee
          </Text>
          <Text style={baseStyles.cellAmount}>
            {fmtMyr(props.totals.socsoEmployee)}
          </Text>
        </View>
        <View style={baseStyles.rowLine}>
          <Text style={baseStyles.cellLabel}>
            Pertubuhan Keselamatan Sosial (SOCSO) — Employer
          </Text>
          <Text style={baseStyles.cellAmount}>
            {fmtMyr(props.totals.socsoEmployer)}
          </Text>
        </View>
        <View style={baseStyles.rowLine}>
          <Text style={baseStyles.cellLabel}>
            Employment Insurance System (EIS) — Employee
          </Text>
          <Text style={baseStyles.cellAmount}>
            {fmtMyr(props.totals.eisEmployee)}
          </Text>
        </View>
        <View style={baseStyles.rowLine}>
          <Text style={baseStyles.cellLabel}>
            Employment Insurance System (EIS) — Employer
          </Text>
          <Text style={baseStyles.cellAmount}>
            {fmtMyr(props.totals.eisEmployer)}
          </Text>
        </View>
        <View style={baseStyles.rowLine}>
          <Text style={baseStyles.cellLabel}>HRDF (HRD Corp levy)</Text>
          <Text style={baseStyles.cellAmount}>
            {fmtMyr(props.totals.hrdf)}
          </Text>
        </View>
        <View style={baseStyles.totalRow}>
          <Text style={baseStyles.totalLabel}>Total statutory remittance</Text>
          <Text style={baseStyles.totalAmount}>
            {fmtMyr(
              props.totals.pcb +
                epfTotal +
                socsoTotal +
                eisTotal +
                props.totals.hrdf,
            )}
          </Text>
        </View>

        <Text style={baseStyles.faintNote}>
          This is a payment schedule, not a bank GIRO upload file. For
          the bank file, download &ldquo;Bank disbursement CSV&rdquo;.
        </Text>

        <View style={baseStyles.footer} fixed>
          <Text>Generated {fmtDate(props.generatedAt)}</Text>
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

// ─── 2. PCB Calculation Details (LHDN-form replica) ─────────────────────
//
// The previous "Detailed Calculations" PDF (compact inline form using
// PcbBreakdownBlock / PcbArBlock / CalcRow / PcbVar helpers) was
// removed in 2026-06. It's been superseded by
// `PcbCalculationDetailsPdfDocument` below, which renders the audit-
// ready LHDN MTD §E worksheet. Old PayrollRunReport cache rows tagged
// `DETAILED_CALCULATIONS_PDF` are no longer reachable through the
// downloads modal but the enum value stays in Prisma so historical
// rows can still be inspected by hand.

export type PcbCalculationDetailsPdfDocumentProps = {
  organizationName: string
  period: string
  payslips: PayslipRow[]
  generatedAt: Date
}

const lhdnStyles = StyleSheet.create({
  headerBar: {
    backgroundColor: "#1f3a5f", // dark navy, matches LHDN form style
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  headerBarText: {
    color: "#ffffff",
    fontFamily: "Helvetica-Bold",
    fontSize: 13,
  },
  employeeName: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    marginTop: 6,
  },
  employeeMeta: {
    color: COLOURS.muted,
    fontSize: 9,
    marginTop: 1,
    marginBottom: 10,
  },
  sectionTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    color: COLOURS.ink,
    marginTop: 12,
    marginBottom: 6,
  },
  subsectionTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9.5,
    color: COLOURS.ink,
    marginTop: 6,
    marginBottom: 2,
  },
  formulaLine: {
    fontSize: 8.5,
    color: COLOURS.muted,
    marginBottom: 4,
    fontFamily: "Helvetica-Oblique",
  },
  formulaIntro: {
    fontSize: 9,
    color: COLOURS.ink,
    marginTop: 4,
    marginBottom: 2,
  },
  varRow: {
    flexDirection: "row",
    paddingVertical: 4,
    borderBottomWidth: 0.25,
    borderBottomColor: COLOURS.divider,
  },
  varBox: { flex: 1, paddingRight: 8 },
  varAbbrev: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    color: COLOURS.ink,
    marginBottom: 1,
  },
  varDescription: {
    fontSize: 8,
    color: COLOURS.muted,
    lineHeight: 1.3,
  },
  varAmount: {
    width: 80,
    textAlign: "right",
    fontSize: 9,
    color: COLOURS.ink,
  },
  varAmountBold: {
    width: 80,
    textAlign: "right",
    fontSize: 9.5,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.ink,
  },
})

export function PcbCalculationDetailsPdfDocument(
  props: PcbCalculationDetailsPdfDocumentProps,
) {
  return (
    <Document
      title={`PCB Calculation Details ${props.period}`}
      author={props.organizationName}
    >
      {props.payslips.map((p) => (
        <Page key={p.id} size="A4" style={baseStyles.page}>
          <View style={lhdnStyles.headerBar}>
            <Text style={lhdnStyles.headerBarText}>PCB Calculation Details</Text>
          </View>

          <Text style={lhdnStyles.employeeName}>{p.snapshotName}</Text>
          <Text style={lhdnStyles.employeeMeta}>
            {p.snapshotPosition ? p.snapshotPosition : ""}
            {p.snapshotEmployeeId ? ` · ${p.snapshotEmployeeId}` : ""} ·{" "}
            {props.period}
          </Text>

          <PcbCalculationDetailsBody pcbCalculation={p.pcbCalculation} />

          <View style={baseStyles.footer} fixed>
            <Text>
              {props.organizationName} · Generated {fmtDate(props.generatedAt)}
            </Text>
            <Text
              render={({ pageNumber, totalPages }) =>
                `${pageNumber} / ${totalPages}`
              }
            />
          </View>
        </Page>
      ))}
    </Document>
  )
}

/**
 * Renders the LHDN-form body. Three numbered sections:
 *   1. PCB(A) — Normal PCB on yearly net remuneration (excluding AR)
 *   2. PCB(B) — PCB on additional remuneration (bonus, commission, etc.)
 *   3. Net PCB — PCB(A) + PCB(B) summary
 *
 * Section 2 is omitted when there's no AR this run (clean monthly run).
 * Section 3 always shows so the reader can confirm "what was actually
 * deducted = X this month".
 */
function PcbCalculationDetailsBody({
  pcbCalculation,
}: {
  pcbCalculation: unknown
}) {
  if (!pcbCalculation || typeof pcbCalculation !== "object") {
    return (
      <Text style={{ fontSize: 9, color: COLOURS.muted, marginTop: 12 }}>
        PCB calculation snapshot not available. Regenerate the payroll run to
        populate this report.
      </Text>
    )
  }

  const v = pcbCalculation as Record<string, unknown> & { formula?: string }

  if (v.formula === "nonResident") {
    return (
      <View>
        <Text style={lhdnStyles.sectionTitle}>
          Non-resident — flat-rate withholding
        </Text>
        <Text style={{ fontSize: 9, color: COLOURS.muted }}>
          Non-residents are taxed at a flat 30% under LHDN MTD spec; the
          LHDN-form variable breakdown is not applicable. Total PCB deducted
          this month: RM {((v.totalPcb as number) ?? 0).toFixed(2)}.
        </Text>
      </View>
    )
  }

  if (v.formula !== "resident") return null

  const num = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : 0)
  const Y = num("Y"), K = num("K")
  const Y1 = num("Y1"), K1 = num("K1")
  const Y2 = num("Y2"), K2 = num("K2"), n = num("n")
  const sumYK = num("sumYK")
  const D = num("D"), S = num("S"), Du = num("Du"), Su = num("Su")
  const Q = num("Q"), C = num("C"), QC = num("QC")
  const sumLP = num("sumLP"), LP1 = num("LP1")
  const P = num("P"), M = num("M"), R = num("R"), B = num("B")
  const Z = num("Z"), X = num("X")
  const yearlyTax = num("yearlyTax")
  const currentMonthPcb = num("currentMonthPcb")
  const pcbAfterThreshold = num("pcbAfterThreshold")

  const ar = (v.ar as Record<string, unknown> | undefined) ?? {}
  const arNum = (k: string) => (typeof ar[k] === "number" ? (ar[k] as number) : 0)
  const Yt = arNum("Yt")
  const Kt = arNum("Kt")
  const chargeableWithAr = arNum("chargeableWithAr")
  const M2 = arNum("M2"), R2 = arNum("R2"), B2 = arNum("B2")
  const CS = arNum("CS")
  const pcbB = arNum("pcbB")
  const pcbC = arNum("pcbC")
  const pcbCurrentMonth = arNum("pcbCurrentMonth")

  // Formula expansion for P — the full arithmetic the LHDN form shows
  // inline so the auditor can re-derive P from primitives.
  const formulaP = `[${fmt(sumYK)} + (${fmt(Y1)} - ${fmt(K1)}) + (${fmt(Y2)} - [${fmt(K2)} × ${n.toFixed(0)}])] - [${fmt(D)} + ${fmt(S)} + ${fmt(Du)} + ${fmt(Su)} + (${fmt(Q)} × ${C.toFixed(0)}) + ${fmt(sumLP)} + ${fmt(LP1)}]`

  return (
    <View>
      {/* ── Section 1: PCB(A) Normal ─────────────────────────────────── */}
      <Text style={lhdnStyles.sectionTitle}>
        1. PCB to yearly net remuneration excluding the additional
        remuneration
      </Text>
      <Text style={lhdnStyles.subsectionTitle}>PCB (A) / Net PCB</Text>
      <Text style={lhdnStyles.formulaLine}>
        {`[(P - M)R + B - (Z + X)] / (n + 1) - Zakat/Fitrah/Levy for current month`}
      </Text>
      <Text style={lhdnStyles.formulaIntro}>
        P · Total chargeable income for a year excluding additional
        remuneration
      </Text>
      <Text style={lhdnStyles.formulaLine}>
        {`[Σ(Y-K) + (Y₁ - K₁) + (Y₂ - [K₂ × n]) + (Yt - Kt)] - (D + S + Du + Su + Q×C + ΣLP + LP₁)  where (Yt - Kt) = 0`}
      </Text>

      <LhdnVar
        abbrev="Σ(Y-K)"
        description="Total accumulated net remuneration including net additional remuneration which has been paid to an employee until before current month including net remuneration which has been paid by previous employer (if any)."
        amount={sumYK}
      />
      <LhdnVar
        abbrev="Y"
        description="Total monthly gross remuneration and additional remuneration which has been paid including monthly gross remuneration paid by previous employer (if any)."
        amount={Y}
      />
      <LhdnVar
        abbrev="K"
        description="Total contribution to EPF or Other Approved Funds made on all remuneration (monthly remuneration, additional remuneration and remuneration from previous employer on current year) that was paid (including premium claimed under previous employment, if any) not exceeding RM4,000.00 per year."
        amount={K}
      />
      <LhdnVar
        abbrev="Y₁"
        description="Current month's normal remuneration."
        amount={Y1}
      />
      <LhdnVar
        abbrev="K₁"
        description="Contribution to EPF or Other Approved Funds paid subject to total qualifying amount for current month's remuneration not exceeding RM4,000.00 per year."
        amount={K1}
      />
      <LhdnVar
        abbrev="Y₂"
        description="Estimated remuneration as per Y₁ for the following months."
        amount={Y2}
      />
      <LhdnVar
        abbrev="K₂"
        description="Estimated balance of total contribution to EPF or other Approved Scheme paid for the qualifying monthly balance [(RM4,000 (limited) - (K + K₁ + Kt)) ÷ n] or K₁, whichever is lower."
        amount={K2}
      />
      <LhdnVar
        abbrev="n"
        description="Remaining working month in a year."
        amount={n}
        raw
      />
      <LhdnVar
        abbrev="D"
        description="Deduction for individual."
        amount={D}
      />
      <LhdnVar
        abbrev="S"
        description="Deduction for spouse."
        amount={S}
      />
      <LhdnVar
        abbrev="Du"
        description="Deduction for disabled individual."
        amount={Du}
      />
      <LhdnVar
        abbrev="Su"
        description="Deduction for disabled spouse."
        amount={Su}
      />
      <LhdnVar
        abbrev="Q"
        description="Deduction per eligible child."
        amount={Q}
      />
      <LhdnVar
        abbrev="C"
        description="Number of eligible children."
        amount={C}
        raw
      />
      <LhdnVar
        abbrev="ΣLP"
        description="Other accumulated allowable deductions including from previous employment (if any)."
        amount={sumLP}
      />
      <LhdnVar
        abbrev="LP₁"
        description="Other allowable deductions for current month."
        amount={LP1}
      />
      <LhdnVar
        abbrev="P"
        description={formulaP}
        amount={P}
        bold
      />
      <LhdnVar
        abbrev="M"
        description="Amount of first chargeable income for every range of chargeable income a year."
        amount={M}
      />
      <LhdnVar
        abbrev="R"
        description={`Percentage of tax rates. (${(R * 100).toFixed(2)}%)`}
        amount={R}
        raw
      />
      <LhdnVar
        abbrev="B"
        description="Amount of tax on M less tax rebate for individual and spouse (if qualified)."
        amount={B}
      />
      <LhdnVar
        abbrev="Z"
        description="Accumulated Zakat/Fitrah/Levy paid other than Zakat/Fitrah/Levy for current month."
        amount={Z}
      />
      <LhdnVar
        abbrev="X"
        description="Accumulated PCB paid in respect of previous month(s) (excluding the current month)."
        amount={X}
      />
      <LhdnVar
        abbrev="Yearly Tax"
        description={`(P - M)R + B = (${fmt(P)} - ${fmt(M)}) × ${R.toFixed(2)} + (${fmt(B)})`}
        amount={yearlyTax}
        bold
      />
      <LhdnVar
        abbrev="PCB(A)"
        description={`Current Month PCB = (Yearly Tax - Z - X) ÷ (n + 1) = (${fmt(yearlyTax)} - ${fmt(Z)} - ${fmt(X)}) ÷ ${(n + 1).toFixed(0)}`}
        amount={currentMonthPcb}
        bold
      />

      {/* ── Section 2: Yearly PCB (PCB B — annual normal projection) ── */}
      <Text style={lhdnStyles.sectionTitle}>2. Yearly PCB</Text>
      <Text style={lhdnStyles.subsectionTitle}>PCB (B)</Text>
      <Text style={lhdnStyles.formulaLine}>
        {`(X) + [Current Month PCB × (n + 1)]`}
      </Text>
      <Text style={lhdnStyles.formulaLine}>
        {`(${fmt(X)}) + [${fmt(pcbAfterThreshold)} × (${n.toFixed(0)} + 1)]`}
      </Text>
      <LhdnVar
        abbrev="PCB (B)"
        description="Projected annual normal PCB — what the year-end PCB would total if the employee earned this month's normal PCB every remaining month, plus the YTD already paid."
        amount={pcbB}
        bold
      />

      {/* ── Section 3: Yearly Tax (CS) — chargeable income with AR ─── */}
      <Text style={lhdnStyles.sectionTitle}>3. Yearly Tax</Text>
      <Text style={lhdnStyles.subsectionTitle}>CS</Text>
      <Text style={lhdnStyles.formulaLine}>
        {`(P - M)R + B`}
      </Text>
      <Text style={lhdnStyles.formulaIntro}>
        P · Total income tax for a year including current additional
        remuneration
      </Text>
      <Text style={lhdnStyles.formulaLine}>
        {`[Σ(Y-K) + (Y₁ - K₁) + (Y₂ - [K₂ × n]) + (Yt - Kt)] - (D + S + Du + Su + Q×C + ΣLP + LP₁)`}
      </Text>

      <LhdnVar
        abbrev="Yt"
        description="Gross additional remuneration for current month."
        amount={Yt}
      />
      <LhdnVar
        abbrev="Kt"
        description="Contribution to EPF or Other Approved Funds for current month's additional remuneration subject to total qualifying amount not exceeding RM4,000.00 per year."
        amount={Kt}
      />
      <LhdnVar
        abbrev="P"
        description={`Total chargeable income for a year including AR — recomputed from Section 1's P with Yt added and Kt deducted = ${fmt(P)} + ${fmt(Yt)} - ${fmt(Kt)}`}
        amount={chargeableWithAr}
        bold
      />
      <LhdnVar
        abbrev="M₂"
        description="Amount of first chargeable income for the range that P (with AR) falls into. May differ from Section 1's M when AR pushes the chargeable income across a tax bracket."
        amount={M2}
      />
      <LhdnVar
        abbrev="R₂"
        description={`Percentage of tax rates. (${(R2 * 100).toFixed(2)}%)`}
        amount={R2}
        raw
      />
      <LhdnVar
        abbrev="B₂"
        description="Amount of tax on M₂ less tax rebate for individual and spouse (if qualified)."
        amount={B2}
      />
      <LhdnVar
        abbrev="CS"
        description={`Yearly tax including AR = (P - M₂)R₂ + B₂ = (${fmt(chargeableWithAr)} - ${fmt(M2)}) × ${R2.toFixed(2)} + (${fmt(B2)})`}
        amount={CS}
        bold
      />

      {/* ── Section 4: Additional Remuneration PCB (PCB C) ─────────── */}
      <Text style={lhdnStyles.sectionTitle}>4. Additional Remuneration PCB</Text>
      <Text style={lhdnStyles.subsectionTitle}>PCB (C)</Text>
      <Text style={lhdnStyles.formulaLine}>
        {`CS - [PCB (B) + Accumulated Zakat that have been paid]`}
      </Text>
      <Text style={lhdnStyles.formulaLine}>
        {`${fmt(CS)} - [${fmt(pcbB)} + ${fmt(Z)}]`}
      </Text>
      <LhdnVar
        abbrev="PCB (C)"
        description="Additional Remuneration PCB — the marginal PCB owed because of the AR amount this month (after MTD threshold + 5c rounding)."
        amount={pcbC}
        bold
      />

      {/* ── Section 5: PCB Current Month ────────────────────────────── */}
      <Text style={lhdnStyles.sectionTitle}>5. PCB Current Month</Text>
      <Text style={lhdnStyles.subsectionTitle}>
        PCB (after rounding up to the nearest 5 cents)
      </Text>
      <Text style={lhdnStyles.formulaLine}>
        {`PCB (A) + PCB (C)`}
      </Text>
      <Text style={lhdnStyles.formulaLine}>
        {`${fmt(pcbAfterThreshold)} + ${fmt(pcbC)}`}
      </Text>
      <LhdnVar
        abbrev="PCB"
        description="Net PCB this month — the amount actually deducted from the employee's pay and remitted to LHDN."
        amount={pcbCurrentMonth}
        bold
      />

      {/* ── ΣLP & LP₁ Details ───────────────────────────────────────── */}
      <Text style={lhdnStyles.sectionTitle}>ΣLP & LP₁ Details</Text>
      <LhdnVar
        abbrev="SOCSO & EIS"
        description="Employee SOCSO + EIS contributions used as LP relief. ΣLP is the YTD accumulated amount; LP₁ is this month's amount. Capped at RM 350/year per LHDN."
        amount={sumLP + LP1}
      />
    </View>
  )
}

function LhdnVar({
  abbrev,
  description,
  amount,
  bold,
  raw,
}: {
  abbrev: string
  description: string
  amount: number
  bold?: boolean
  raw?: boolean
}) {
  return (
    <View style={lhdnStyles.varRow}>
      <View style={lhdnStyles.varBox}>
        <Text style={lhdnStyles.varAbbrev}>{abbrev}</Text>
        <Text style={lhdnStyles.varDescription}>{description}</Text>
      </View>
      <Text style={bold ? lhdnStyles.varAmountBold : lhdnStyles.varAmount}>
        {raw
          ? amount.toFixed(2)
          : trunc2(amount).toLocaleString("en-MY", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
      </Text>
    </View>
  )
}

// Truncate to 2dp without rounding. Used by the LHDN-form PDF so the
// displayed values match what an auditor gets by computing the
// formulas by hand (and matches Payroll Panda's convention — even
// 15.098 displays as 15.09, not 15.10). `Math.trunc` toward zero so
// negative numbers like B = -250.00 don't drift to -250.01.
function trunc2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.trunc(n * 100) / 100
}

function fmt(n: number): string {
  return trunc2(n).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// Helpers `CalcRow`, `PcbBreakdownBlock`, `PcbArBlock`, `PcbVar` were
// deleted alongside `DetailedCalculationsPdfDocument` in 2026-06. The
// LHDN-form PCB Calculation Details PDF below uses its own `LhdnVar`
// helper (with its own styles) and doesn't depend on them.


// ─── 3. Bulk Payslips ───────────────────────────────────────────────────

export type BulkPayslipsPdfDocumentProps = {
  organizationName: string
  period: string
  /// Issue date printed on the payslip header — typically the last
  /// calendar day of the period month.
  issueDate: Date
  payslips: PayslipRow[]
  generatedAt: Date
}

const payslipStyles = StyleSheet.create({
  page: {
    paddingTop: 32,
    paddingBottom: 36,
    paddingHorizontal: 40,
    fontSize: 10,
    color: COLOURS.ink,
    fontFamily: "Helvetica",
  },
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 4,
  },
  bigTitle: { fontSize: 18, fontFamily: "Helvetica-Bold" },
  meta: { fontSize: 9.5, color: COLOURS.muted },
  hr: {
    height: 1,
    backgroundColor: COLOURS.rule,
    marginTop: 8,
    marginBottom: 12,
  },
  twoCol: {
    flexDirection: "row",
    gap: 24,
  },
  colHalf: { flex: 1 },
  colTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    marginBottom: 4,
  },
  payRow: { flexDirection: "row", paddingVertical: 1.5 },
  payLabel: { flex: 3 },
  payAmount: { flex: 1, textAlign: "right" },
  subTotal: {
    flexDirection: "row",
    paddingTop: 4,
    marginTop: 2,
    borderTopWidth: 0.5,
    borderTopColor: COLOURS.divider,
  },
  subTotalLabel: { flex: 3, fontFamily: "Helvetica-Bold" },
  subTotalAmount: {
    flex: 1,
    textAlign: "right",
    fontFamily: "Helvetica-Bold",
  },
  netBlock: {
    marginTop: 12,
    padding: 10,
    backgroundColor: "#ecfdf5", // emerald-50
    borderLeftWidth: 3,
    borderLeftColor: COLOURS.positive,
  },
  netLabel: { fontFamily: "Helvetica-Bold", fontSize: 11 },
  netAmount: {
    marginTop: 2,
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.positive,
  },
})

export function BulkPayslipsPdfDocument(props: BulkPayslipsPdfDocumentProps) {
  return (
    <Document
      title={`Payslips ${props.period}`}
      author={props.organizationName}
    >
      {props.payslips.map((p) => (
        <Page key={p.id} size="A4" style={payslipStyles.page}>
          <View style={payslipStyles.titleRow}>
            <View>
              <Text style={payslipStyles.bigTitle}>Payslip</Text>
              <Text style={payslipStyles.meta}>
                Salary {props.period} · Issued {fmtDate(props.issueDate)}
              </Text>
            </View>
            <Text style={payslipStyles.meta}>{props.organizationName}</Text>
          </View>
          <View style={payslipStyles.hr} />

          <View style={payslipStyles.twoCol}>
            <View style={payslipStyles.colHalf}>
              <Text style={payslipStyles.colTitle}>Employee</Text>
              <Text>{p.snapshotName}</Text>
              <Text style={payslipStyles.meta}>
                {p.snapshotEmployeeId}
                {p.snapshotPosition ? ` · ${p.snapshotPosition}` : ""}
              </Text>
            </View>
            <View style={payslipStyles.colHalf}>
              <Text style={payslipStyles.colTitle}>Pay Period</Text>
              <Text>{props.period}</Text>
              <Text style={payslipStyles.meta}>
                {p.snapshotIsResident ? "Resident" : "Non-resident"}
                {p.snapshotNationality ? ` · ${p.snapshotNationality}` : ""}
              </Text>
            </View>
          </View>

          <View style={{ marginTop: 16 }}>
            <Text style={payslipStyles.colTitle}>Earnings</Text>
            <PayRow label="Basic pay" amount={p.proratedPay} />
            {p.otPay !== 0 ? (
              <PayRow label="Overtime" amount={p.otPay} />
            ) : null}
            {p.totalAllowances !== 0 ? (
              <PayRow label="Allowances" amount={p.totalAllowances} />
            ) : null}
            {p.totalReimbursements !== 0 ? (
              <PayRow label="Reimbursements" amount={p.totalReimbursements} />
            ) : null}
            <View style={payslipStyles.subTotal}>
              <Text style={payslipStyles.subTotalLabel}>Total earnings</Text>
              {/* grossPay already includes proratedPay + otPay +
                  totalAllowances + totalReimbursements (per calc.ts
                  L1019). Don't add reimbursements again or we
                  double-count. */}
              <Text style={payslipStyles.subTotalAmount}>
                {fmtMyr(p.grossPay)}
              </Text>
            </View>
          </View>

          <View style={{ marginTop: 14 }}>
            <Text style={payslipStyles.colTitle}>Deductions</Text>
            <PayRow label="Employee EPF" amount={p.epfEmployee} />
            {/* PCB shown here is post-zakat-offset (calc.ts already
                subtracted zakat). Zakat is also rolled into
                `totalDeductions`, so when we display zakat separately
                we have to subtract it from "Other deductions" to
                avoid double-counting. */}
            <PayRow label="PCB / MTD" amount={p.pcb} />
            <PayRow label="Employee SOCSO" amount={p.socsoEmployee} />
            <PayRow label="Employee EIS" amount={p.eisEmployee} />
            {p.zakat > 0 ? (
              <PayRow label="Zakat" amount={p.zakat} />
            ) : null}
            {(() => {
              const otherDeductions = Math.max(
                0,
                p.totalDeductions - p.zakat,
              )
              return otherDeductions > 0 ? (
                <PayRow label="Other deductions" amount={otherDeductions} />
              ) : null
            })()}
            <View style={payslipStyles.subTotal}>
              <Text style={payslipStyles.subTotalLabel}>Total deductions</Text>
              {/* Match the calc engine's netPay formula:
                    netPay = grossPay - epf - socso - eis - pcb
                            - totalDeductions
                  Zakat is inside totalDeductions, so we don't add it
                  again here. */}
              <Text style={payslipStyles.subTotalAmount}>
                {fmtMyr(
                  p.epfEmployee +
                    p.pcb +
                    p.socsoEmployee +
                    p.eisEmployee +
                    p.totalDeductions,
                )}
              </Text>
            </View>
          </View>

          <View style={payslipStyles.netBlock}>
            <Text style={payslipStyles.netLabel}>Net pay</Text>
            <Text style={payslipStyles.netAmount}>RM {fmtMyr(p.netPay)}</Text>
          </View>

          <View style={{ marginTop: 16 }}>
            <Text style={payslipStyles.colTitle}>Employer Contributions</Text>
            <PayRow label="EPF" amount={p.epfEmployer} />
            <PayRow label="SOCSO" amount={p.socsoEmployer} />
            <PayRow label="EIS" amount={p.eisEmployer} />
            <PayRow label="HRDF" amount={p.hrdf} />
          </View>

          {p.totalBenefitsInKind > 0 ? (
            <View style={{ marginTop: 12 }}>
              <Text style={payslipStyles.colTitle}>
                Benefits-in-kind (BIK, non-cash)
              </Text>
              <PayRow label="Total BIK" amount={p.totalBenefitsInKind} />
            </View>
          ) : null}

          <View style={baseStyles.footer} fixed>
            <Text>Generated {fmtDate(props.generatedAt)}</Text>
            <Text
              render={({ pageNumber, totalPages }) =>
                `${pageNumber} / ${totalPages}`
              }
            />
          </View>
        </Page>
      ))}
    </Document>
  )
}

function PayRow(props: { label: string; amount: number }) {
  return (
    <View style={payslipStyles.payRow}>
      <Text style={payslipStyles.payLabel}>{props.label}</Text>
      <Text style={payslipStyles.payAmount}>{fmtMyr(props.amount)}</Text>
    </View>
  )
}
