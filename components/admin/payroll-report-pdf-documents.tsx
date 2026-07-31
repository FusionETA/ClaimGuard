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
 *   3. `EmployeePayslipPdfDocument`
 *      — One employee's payslip rendered as a single-page PDF. The
 *        bulk-payslips renderer calls this once per employee and zips
 *        the resulting PDFs so admins distribute individual files
 *        rather than one concatenated PDF.
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
  const KtEffective = arNum("KtEffective")
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
        {`(${fmt(X)}) + [${fmt(currentMonthPcb)} × (${n.toFixed(0)} + 1)]`}
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
        description={`Total chargeable income for a year including AR — recomputed from Section 1's P with Yt added and Kt deducted = ${fmt(P)} + ${fmt(Yt)} - ${fmt(KtEffective)} (Kt ${fmt(Kt)} capped at remaining RM 4,000 cap = ${fmt(KtEffective)})`}
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
        {`${fmt(currentMonthPcb)} + ${fmt(pcbC)}`}
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
        abbrev="ΣLP + LP₁"
        description="Allowable deductions: employee SOCSO + EIS + SKBBK contributions (capped at RM 350/year combined) PLUS any TP1-declared relief line items (life insurance, medical insurance, PRS, serious-disease medical, lifestyle, sports equipment, etc. — each capped per LHDN Public Ruling). ΣLP is the YTD accumulated amount; LP₁ is this month's amount."
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
// 15.098 displays as 15.09, not 15.10). Truncation is toward zero so
// negative numbers like B = -250.00 don't drift to -250.01.
//
// NOTE on IEEE 754: the naive `Math.trunc(n * 100) / 100` is unsafe
// for "clean" 2dp values because their float representation drifts.
// For example, `32.55 * 100 = 3254.9999999999995` in JS, so the
// naive version returns 32.54 — that's what made Kang Nickee's
// SOCSO + EIS row read 32.54 instead of 32.55, then cascade through
// the displayed P value (41,567.51 vs the actual 41,567.52). We go
// through `toFixed` for a fixed-precision string representation (no
// drift past the 10th decimal) and lexically slice to 2dp.
function trunc2(n: number): number {
  if (!Number.isFinite(n)) return 0
  const negative = n < 0
  const abs = Math.abs(n)
  const str = abs.toFixed(10)
  const dotIdx = str.indexOf(".")
  if (dotIdx === -1) return n
  const truncated = Number(str.slice(0, dotIdx + 3))
  return negative ? -truncated : truncated
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

/// One payslip row enriched with the extras the dense PDF needs on
/// top of `PayslipRow`: per-employee identity for the header block
/// and calendar-year YTD totals for the per-statutory matrix.
export type BulkPayslipPdfRow = PayslipRow & {
  identity: {
    idNumber: string | null
    joinDate: Date | null
    paymentMethod: string
    bankName: string | null
    bankAccountNumber: string | null
    epfNumber: string | null
    socsoNumber: string | null
    incomeTaxNumber: string | null
  } | null
  ytd: {
    gross: number
    net: number
    epfEmployee: number
    epfEmployer: number
    socsoEmployee: number
    socsoEmployer: number
    eisEmployee: number
    eisEmployer: number
    pcb: number
    hrdf: number
  }
}

export type EmployeePayslipPdfDocumentProps = {
  organizationName: string
  period: string
  /// Issue date printed on the payslip header — typically the last
  /// calendar day of the period month.
  issueDate: Date
  payslip: BulkPayslipPdfRow
  generatedAt: Date
}

// AltomateHR brand purple — used as the single accent across the
// payslip PDF (org-name underline, section labels, YTD column headers).
// Matches `--primary` in the app's Tailwind palette.
const PAYSLIP_BRAND = "#5b21b6"

const payslipStyles = StyleSheet.create({
  page: {
    paddingTop: 30,
    paddingBottom: 36,
    paddingHorizontal: 36,
    fontSize: 9.5,
    color: COLOURS.ink,
    fontFamily: "Helvetica",
  },
  // ─── Header ───────────────────────────────────────────────────────
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 4,
  },
  orgName: {
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    color: COLOURS.ink,
  },
  periodTag: {
    fontSize: 9,
    color: COLOURS.muted,
    textAlign: "right",
  },
  brandRule: {
    height: 2,
    backgroundColor: PAYSLIP_BRAND,
    marginTop: 4,
    marginBottom: 10,
  },
  // ─── Identity grid ────────────────────────────────────────────────
  identityGrid: {
    flexDirection: "row",
    gap: 18,
    marginBottom: 12,
  },
  identityCol: { flex: 1 },
  identityRow: { flexDirection: "row", paddingVertical: 1.5 },
  identityLabel: {
    width: 80,
    color: COLOURS.muted,
    fontSize: 9,
  },
  identityValue: {
    flex: 1,
    fontSize: 9.5,
  },
  // ─── Section headers ──────────────────────────────────────────────
  sectionLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    color: PAYSLIP_BRAND,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  // ─── Earnings / Deductions two-column block ───────────────────────
  earningsDeductionsRow: {
    flexDirection: "row",
    gap: 20,
  },
  edCol: { flex: 1 },
  payRow: {
    flexDirection: "row",
    paddingVertical: 1.8,
  },
  payLabel: { flex: 3 },
  payAmount: { flex: 1, textAlign: "right" },
  subTotalRow: {
    flexDirection: "row",
    paddingTop: 4,
    marginTop: 4,
    borderTopWidth: 0.5,
    borderTopColor: COLOURS.divider,
  },
  subTotalLabel: { flex: 3, fontFamily: "Helvetica-Bold" },
  subTotalAmount: {
    flex: 1,
    textAlign: "right",
    fontFamily: "Helvetica-Bold",
  },
  // ─── Net pay banner ───────────────────────────────────────────────
  netRow: {
    marginTop: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: COLOURS.panelBg,
    borderLeftWidth: 3,
    borderLeftColor: PAYSLIP_BRAND,
  },
  netLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    color: COLOURS.ink,
  },
  netAmount: {
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    color: PAYSLIP_BRAND,
  },
  // ─── YTD matrix ───────────────────────────────────────────────────
  ytdSummary: { flexDirection: "row", paddingVertical: 1.5 },
  ytdSummaryLabel: { flex: 1, color: COLOURS.muted },
  ytdSummaryValue: { textAlign: "right" },
  matrixHeaderRow: {
    flexDirection: "row",
    marginTop: 6,
    paddingBottom: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: COLOURS.rule,
  },
  matrixLabelCell: { flex: 1.4, fontFamily: "Helvetica-Bold", fontSize: 9 },
  matrixNumCell: {
    flex: 1,
    textAlign: "right",
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    color: COLOURS.muted,
  },
  matrixRow: {
    flexDirection: "row",
    paddingVertical: 2,
  },
  matrixRowLabel: { flex: 1.4 },
  matrixNum: { flex: 1, textAlign: "right" },
  // ─── Footer ───────────────────────────────────────────────────────
  payslipFooter: {
    position: "absolute",
    left: 36,
    right: 36,
    bottom: 18,
    paddingTop: 6,
    borderTopWidth: 0.5,
    borderTopColor: COLOURS.divider,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 8,
    color: COLOURS.muted,
  },
})

/**
 * Single-employee payslip PDF. The renderer (see
 * `bulk-payslips-pdf.tsx`) calls this once per employee and zips the
 * resulting buffers, so each employee gets their own PDF inside the
 * downloaded ZIP. We deliberately use ONE Document per employee
 * instead of one Document with N pages so that the resulting PDFs
 * are individually shareable / printable.
 */
export function EmployeePayslipPdfDocument(
  props: EmployeePayslipPdfDocumentProps,
) {
  const p = props.payslip
  return (
    <Document
      title={`Payslip ${props.period} - ${p.snapshotName}`}
      author={props.organizationName}
    >
      <Page size="A4" style={payslipStyles.page}>
          {/* ── Header: org name + period ─────────────────────────── */}
          <View style={payslipStyles.headerRow}>
            <Text style={payslipStyles.orgName}>{props.organizationName}</Text>
            <Text style={payslipStyles.periodTag}>
              Payslip for {props.period}
              {"\n"}Issued {fmtDate(props.issueDate)}
            </Text>
          </View>
          <View style={payslipStyles.brandRule} />

          {/* ── Identity grid: 2 columns × 4 rows of labelled facts ── */}
          <View style={payslipStyles.identityGrid}>
            <View style={payslipStyles.identityCol}>
              <IdentityField label="Employee" value={p.snapshotName} />
              <IdentityField
                label="IC / Passport"
                value={p.identity?.idNumber ?? "—"}
              />
              <IdentityField
                label="Join date"
                value={
                  p.identity?.joinDate ? fmtDate(p.identity.joinDate) : "—"
                }
              />
              <IdentityField label="Employee ID" value={p.snapshotEmployeeId} />
            </View>
            <View style={payslipStyles.identityCol}>
              <IdentityField
                label="Designation"
                value={p.snapshotPosition ?? "—"}
              />
              <IdentityField
                label="Payment mode"
                value={paymentModeLabel(p.identity?.paymentMethod)}
              />
              <IdentityField
                label="EPF ref"
                value={p.identity?.epfNumber ?? "—"}
              />
              <IdentityField
                label="SOCSO ref"
                value={p.identity?.socsoNumber ?? "—"}
              />
              <IdentityField
                label="Tax ref"
                value={p.identity?.incomeTaxNumber ?? "—"}
              />
              <IdentityField
                label="Bank account"
                value={maskedBankAccount(
                  p.identity?.bankName,
                  p.identity?.bankAccountNumber,
                )}
              />
            </View>
          </View>

          {/* ── Earnings | Deductions (two equal columns) ─────────── */}
          <View style={payslipStyles.earningsDeductionsRow}>
            <View style={payslipStyles.edCol}>
              <Text style={payslipStyles.sectionLabel}>Earnings</Text>
              <PayRow label="Basic pay" amount={p.proratedPay} />
              {p.otPay !== 0 ? (
                <PayRow label="Overtime" amount={p.otPay} />
              ) : null}
              {p.totalAllowances !== 0 ? (
                <PayRow label="Allowances" amount={p.totalAllowances} />
              ) : null}
              {p.totalReimbursements !== 0 ? (
                <PayRow
                  label="Reimbursements"
                  amount={p.totalReimbursements}
                />
              ) : null}
              <View style={payslipStyles.subTotalRow}>
                <Text style={payslipStyles.subTotalLabel}>Total earnings</Text>
                {/* grossPay = proratedPay + otPay + totalAllowances +
                    totalReimbursements per calc.ts; don't re-add. */}
                <Text style={payslipStyles.subTotalAmount}>
                  {fmtMyr(p.grossPay)}
                </Text>
              </View>
            </View>
            <View style={payslipStyles.edCol}>
              <Text style={payslipStyles.sectionLabel}>Deductions</Text>
              <PayRow label="Employee EPF" amount={p.epfEmployee} />
              {/* PCB shown here is post-zakat-offset (calc.ts already
                  subtracted zakat). Zakat is in `totalDeductions`,
                  subtract once when surfacing the catch-all bucket.
                  Includes Additional PCB (Employment Income): the manual
                  top-up is remitted via the standard PCB field, so it's
                  folded into this figure (and netted out of the "Other
                  deductions" catch-all below), not shown as its own row. */}
              <PayRow label="PCB / MTD" amount={p.pcb + (p.voluntaryPcb ?? 0)} />
              {/* CP38 arrears — LHDN court-ordered additional PCB
                  withholding. Hidden when 0 so ordinary payslips don't
                  show a junk RM 0.00 line. */}
              {(p.cp38 ?? 0) > 0 ? (
                <PayRow label="CP38 Arrears" amount={p.cp38 ?? 0} />
              ) : null}
              <PayRow label="Employee SOCSO" amount={p.socsoEmployee} />
              <PayRow label="Employee EIS" amount={p.eisEmployee} />
              {/* SKBBK (Skim LINDUNG 24 Jam) — employee-only contribution,
                  effective Jun 2026 onwards. Hidden when 0 so older
                  payslips don't show a junk RM 0.00 line. */}
              {(p.skbbkEmployee ?? 0) > 0 ? (
                <PayRow
                  label="SKBBK (LINDUNG 24 Jam)"
                  amount={p.skbbkEmployee ?? 0}
                />
              ) : null}
              {p.zakat > 0 ? (
                <PayRow label="Zakat" amount={p.zakat} />
              ) : null}
              {(() => {
                // Subtract things we've already shown as their own
                // rows above (zakat + cp38 + additional PCB) to avoid
                // double-count in the catch-all "Other deductions" line.
                const other = Math.max(
                  0,
                  p.totalDeductions -
                    p.zakat -
                    (p.cp38 ?? 0) -
                    (p.voluntaryPcb ?? 0),
                )
                return other > 0 ? (
                  <PayRow label="Other deductions" amount={other} />
                ) : null
              })()}
              <View style={payslipStyles.subTotalRow}>
                <Text style={payslipStyles.subTotalLabel}>
                  Total deductions
                </Text>
                <Text style={payslipStyles.subTotalAmount}>
                  {fmtMyr(
                    p.epfEmployee +
                      p.pcb +
                      p.socsoEmployee +
                      p.eisEmployee +
                      (p.skbbkEmployee ?? 0) +
                      p.totalDeductions,
                  )}
                </Text>
              </View>
            </View>
          </View>

          {/* ── Net pay banner ───────────────────────────────────── */}
          <View style={payslipStyles.netRow}>
            <Text style={payslipStyles.netLabel}>Net pay</Text>
            <Text style={payslipStyles.netAmount}>
              MYR {fmtMyr(p.netPay)}
            </Text>
          </View>

          {/* ── Employer contributions ───────────────────────────── */}
          <View style={{ marginTop: 14 }}>
            <Text style={payslipStyles.sectionLabel}>
              Employer contributions
            </Text>
            <View style={payslipStyles.earningsDeductionsRow}>
              <View style={payslipStyles.edCol}>
                <PayRow label="Employer EPF" amount={p.epfEmployer} />
                <PayRow label="Employer SOCSO" amount={p.socsoEmployer} />
              </View>
              <View style={payslipStyles.edCol}>
                <PayRow label="Employer EIS" amount={p.eisEmployer} />
                <PayRow label="HRDF" amount={p.hrdf} />
              </View>
            </View>
          </View>

          {/* Benefits-in-kind section.
              Section only renders when the employee actually has BIK
              this period (gated on the scalar totalBenefitsInKind so
              normal-month payslips don't show an empty header).
              Inside, we enumerate the bik_* line items so the employee
              sees WHICH benefit drove the figure (Company car,
              accommodation, phone, etc.). Falls back to a single
              "Total BIK" row when the scalar is set but no line items
              were attached — happens on legacy / pre-2026-06 imported
              payslips that only carried the scalar total. */}
          {p.totalBenefitsInKind > 0 ? (() => {
            const bikLines = p.lineItems.filter(
              (li) => li.category?.startsWith("bik_"),
            )
            return (
              <View style={{ marginTop: 12 }}>
                <Text style={payslipStyles.sectionLabel}>
                  Benefits-in-kind (BIK, non-cash)
                </Text>
                {bikLines.length > 0 ? (
                  <>
                    {bikLines.map((li) => (
                      <PayRow key={li.id} label={li.label} amount={li.amount} />
                    ))}
                    <View style={payslipStyles.subTotalRow}>
                      <Text style={payslipStyles.subTotalLabel}>Total BIK</Text>
                      <Text style={payslipStyles.subTotalAmount}>
                        {fmtMyr(p.totalBenefitsInKind)}
                      </Text>
                    </View>
                  </>
                ) : (
                  <PayRow label="Total BIK" amount={p.totalBenefitsInKind} />
                )}
              </View>
            )
          })() : null}

          {/* ── Year-to-date ─────────────────────────────────────── */}
          <View style={{ marginTop: 14 }}>
            <Text style={payslipStyles.sectionLabel}>
              Year to date (through {props.period})
            </Text>
            <View style={payslipStyles.ytdSummary}>
              <Text style={payslipStyles.ytdSummaryLabel}>Gross pay</Text>
              <Text style={payslipStyles.ytdSummaryValue}>
                MYR {fmtMyr(p.ytd.gross)}
              </Text>
            </View>
            <View style={payslipStyles.ytdSummary}>
              <Text style={payslipStyles.ytdSummaryLabel}>Net pay</Text>
              <Text style={payslipStyles.ytdSummaryValue}>
                MYR {fmtMyr(p.ytd.net)}
              </Text>
            </View>

            <View style={payslipStyles.matrixHeaderRow}>
              <Text style={payslipStyles.matrixLabelCell}> </Text>
              <Text style={payslipStyles.matrixNumCell}>Employee</Text>
              <Text style={payslipStyles.matrixNumCell}>Employer</Text>
              <Text style={payslipStyles.matrixNumCell}>Total</Text>
            </View>
            <MatrixRow
              label="EPF"
              employee={p.ytd.epfEmployee}
              employer={p.ytd.epfEmployer}
            />
            <MatrixRow
              label="SOCSO"
              employee={p.ytd.socsoEmployee}
              employer={p.ytd.socsoEmployer}
            />
            <MatrixRow
              label="EIS"
              employee={p.ytd.eisEmployee}
              employer={p.ytd.eisEmployer}
            />
            <MatrixRow label="PCB" employee={p.ytd.pcb} employer={0} />
            <MatrixRow label="HRDF" employee={0} employer={p.ytd.hrdf} />
          </View>

          {/* ── Footer (fixed at page bottom) ───────────────────── */}
          <View style={payslipStyles.payslipFooter} fixed>
            <Text>
              Computer-generated payslip — no signature required.
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

function PayRow(props: { label: string; amount: number }) {
  return (
    <View style={payslipStyles.payRow}>
      <Text style={payslipStyles.payLabel}>{props.label}</Text>
      <Text style={payslipStyles.payAmount}>{fmtMyr(props.amount)}</Text>
    </View>
  )
}

function IdentityField(props: { label: string; value: string }) {
  return (
    <View style={payslipStyles.identityRow}>
      <Text style={payslipStyles.identityLabel}>{props.label}</Text>
      <Text style={payslipStyles.identityValue}>{props.value}</Text>
    </View>
  )
}

function MatrixRow(props: {
  label: string
  employee: number
  employer: number
}) {
  const total = props.employee + props.employer
  return (
    <View style={payslipStyles.matrixRow}>
      <Text style={payslipStyles.matrixRowLabel}>{props.label}</Text>
      <Text style={payslipStyles.matrixNum}>{fmtMyr(props.employee)}</Text>
      <Text style={payslipStyles.matrixNum}>{fmtMyr(props.employer)}</Text>
      <Text style={payslipStyles.matrixNum}>{fmtMyr(total)}</Text>
    </View>
  )
}

/// Human label for `PayrollProfile.paymentMethod` enum. Lives here so
/// PDF-side rendering doesn't need to import the app's `PAYMENT_METHOD_LABELS`
/// (a client-side const). Kept short to fit the identity column.
function paymentModeLabel(method: string | undefined): string {
  switch (method) {
    case "BANK_TRANSFER":
      return "Bank transfer"
    case "CHEQUE":
      return "Cheque"
    case "CASH":
      return "Cash"
    case "GIRO":
      return "GIRO"
    default:
      return method ?? "—"
  }
}

/// Mask the bank account number to last-4 to keep the printed payslip
/// safe to forward by email — full account no. is still on the
/// employee's profile in-app. Format: "Maybank ····6789".
function maskedBankAccount(
  bankName: string | null | undefined,
  accountNumber: string | null | undefined,
): string {
  if (!accountNumber) return bankName ?? "—"
  const trimmed = accountNumber.trim()
  const last4 = trimmed.length > 4 ? trimmed.slice(-4) : trimmed
  const masked = trimmed.length > 4 ? `····${last4}` : last4
  return bankName ? `${bankName} ${masked}` : masked
}
