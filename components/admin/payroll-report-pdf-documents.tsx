/**
 * Three additional payroll-run PDF documents, rendered server-side via
 * `@react-pdf/renderer`:
 *
 *   1. `PaymentSchedulePdfDocument`
 *      — Per-employee net amounts + statutory remittance totals.
 *
 *   2. `DetailedCalculationsPdfDocument`
 *      — Per-employee PCB / EPF / SOCSO / EIS / HRDF working.
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

// ─── 2. Detailed Calculations ───────────────────────────────────────────

export type DetailedCalculationsPdfDocumentProps = {
  organizationName: string
  period: string
  payslips: PayslipRow[]
  generatedAt: Date
}

const detailedStyles = StyleSheet.create({
  employeeCard: {
    marginTop: 12,
    paddingTop: 10,
    paddingBottom: 8,
    paddingHorizontal: 10,
    backgroundColor: COLOURS.panelBg,
    borderRadius: 6,
  },
  employeeName: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
  },
  employeeMeta: {
    marginTop: 1,
    color: COLOURS.muted,
    fontSize: 8.5,
  },
  calcGroup: {
    marginTop: 6,
  },
  calcGroupTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    marginBottom: 2,
  },
  calcRow: {
    flexDirection: "row",
    paddingVertical: 1.5,
  },
  calcLabel: { flex: 4, color: COLOURS.ink },
  calcAmount: { flex: 1, textAlign: "right" },
})

export function DetailedCalculationsPdfDocument(
  props: DetailedCalculationsPdfDocumentProps,
) {
  return (
    <Document
      title={`Detailed Calculations ${props.period}`}
      author={props.organizationName}
    >
      <Page size="A4" style={baseStyles.page}>
        <View>
          <Text style={baseStyles.headerOrg}>{props.organizationName}</Text>
          <Text style={baseStyles.headerSub}>
            Detailed calculations · {props.period}
          </Text>
        </View>

        {props.payslips.map((p) => (
          <View key={p.id} style={detailedStyles.employeeCard} wrap={false}>
            <Text style={detailedStyles.employeeName}>{p.snapshotName}</Text>
            <Text style={detailedStyles.employeeMeta}>
              {p.snapshotEmployeeId}
              {p.snapshotPosition ? ` · ${p.snapshotPosition}` : ""} ·{" "}
              {p.snapshotIsResident ? "Resident" : "Non-resident"}{" "}
              {p.snapshotNationality ? `· ${p.snapshotNationality}` : ""}
            </Text>

            <View style={detailedStyles.calcGroup}>
              <Text style={detailedStyles.calcGroupTitle}>
                Gross composition
              </Text>
              <CalcRow label="Basic pay (prorated)" amount={p.proratedPay} />
              <CalcRow label="Overtime pay" amount={p.otPay} />
              <CalcRow label="Allowances (cash)" amount={p.totalAllowances} />
              <CalcRow
                label="Benefits-in-kind (BIK, non-cash)"
                amount={p.totalBenefitsInKind}
              />
              <CalcRow label="Reimbursements" amount={p.totalReimbursements} />
              <CalcRow
                label="Gross pay (cash subject to statutory)"
                amount={p.grossPay}
                bold
              />
            </View>

            <View style={detailedStyles.calcGroup}>
              <Text style={detailedStyles.calcGroupTitle}>EPF (KWSP)</Text>
              <CalcRow
                label={`Employee share (${p.snapshotEpfRates.employee}%)`}
                amount={p.epfEmployee}
              />
              <CalcRow
                label={`Employer share (${p.snapshotEpfRates.employer}%)`}
                amount={p.epfEmployer}
              />
            </View>

            <View style={detailedStyles.calcGroup}>
              <Text style={detailedStyles.calcGroupTitle}>SOCSO + EIS</Text>
              <CalcRow label="SOCSO employee" amount={p.socsoEmployee} />
              <CalcRow label="SOCSO employer" amount={p.socsoEmployer} />
              <CalcRow label="EIS employee" amount={p.eisEmployee} />
              <CalcRow label="EIS employer" amount={p.eisEmployer} />
            </View>

            <View style={detailedStyles.calcGroup}>
              <Text style={detailedStyles.calcGroupTitle}>
                PCB / MTD (LHDN)
              </Text>
              <CalcRow
                label={
                  p.snapshotIsResident
                    ? p.zakat > 0
                      ? "Resident MTD (post-zakat offset)"
                      : "Resident MTD: [(P − M)R + B − (Z + X)] ÷ (n+1)"
                    : "Non-resident MTD: 30% flat"
                }
                amount={p.pcb}
              />
            </View>

            <View style={detailedStyles.calcGroup}>
              <Text style={detailedStyles.calcGroupTitle}>HRDF</Text>
              <CalcRow
                label={`Wage base subject to HRDF`}
                amount={p.hrdfWage}
              />
              <CalcRow label="HRDF levy (employer)" amount={p.hrdf} />
            </View>

            <View style={detailedStyles.calcGroup}>
              <Text style={detailedStyles.calcGroupTitle}>Outcome</Text>
              <CalcRow label="Net pay (employee receives)" amount={p.netPay} bold />
              <CalcRow
                label="Total cost to employer"
                amount={p.totalCostToEmployer}
                bold
              />
            </View>
          </View>
        ))}

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

function CalcRow(props: { label: string; amount: number; bold?: boolean }) {
  return (
    <View style={detailedStyles.calcRow}>
      <Text
        style={[
          detailedStyles.calcLabel,
          props.bold ? { fontFamily: "Helvetica-Bold" } : {},
        ]}
      >
        {props.label}
      </Text>
      <Text
        style={[
          detailedStyles.calcAmount,
          props.bold ? { fontFamily: "Helvetica-Bold" } : {},
        ]}
      >
        {fmtMyr(props.amount)}
      </Text>
    </View>
  )
}

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
                    netPay = grossPay − epf − socso − eis − pcb
                            − totalDeductions
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
