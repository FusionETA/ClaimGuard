/**
 * Per-employee LHDN form PDFs — rendered via `@react-pdf/renderer`.
 *
 *   1. `FormPcb2IiPdfDocument`
 *      — Monthly MTD (PCB) + CP38 statement for one employee for one
 *        calendar year. On-request — typically generated when LHDN asks
 *        during tax clearance or to reconcile a misallocated payment.
 *
 *   2. `FormCp22PdfDocument`      [pending — next commit]
 *   3. `FormCp22aPdfDocument`     [pending]
 *   4. `FormCp21PdfDocument`      [pending]
 *   5. `FormTp3PdfDocument`       [pending]
 *
 * Visual style mirrors `payroll-annual-pdf-documents.tsx` — minimal,
 * statutory-form clarity. Bilingual headings (BM / EN) to match LHDN's
 * own PDFs so an admin can cross-check section numbers.
 */

import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer"

import type { EmployeeFormPayload } from "@/modules/payroll/infrastructure/employee-form.repository"

const COLOURS = {
  ink: "#0f172a",
  muted: "#64748b",
  faint: "#94a3b8",
  divider: "#e2e8f0",
  rule: "#cbd5e1",
  panelBg: "#f8fafc",
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 36,
    paddingHorizontal: 40,
    fontSize: 9,
    color: COLOURS.ink,
    fontFamily: "Helvetica",
  },
  brandBlock: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLOURS.rule,
  },
  brandLeft: { flex: 4 },
  brandRight: { flex: 2, alignItems: "flex-end" },
  brandName: {
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
  },
  brandSub: {
    fontSize: 8.5,
    color: COLOURS.muted,
    marginTop: 2,
  },
  formCode: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
  },
  formCodeSub: {
    fontSize: 8.5,
    color: COLOURS.muted,
    marginTop: 2,
    textAlign: "right",
  },
  titleBlock: {
    alignItems: "center",
    marginBottom: 12,
  },
  formTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 13,
    letterSpacing: 1,
    textAlign: "center",
  },
  formSubtitle: {
    marginTop: 2,
    fontSize: 9,
    color: COLOURS.muted,
    textAlign: "center",
  },
  sectionHeader: {
    marginTop: 12,
    marginBottom: 6,
    paddingVertical: 3,
    paddingHorizontal: 6,
    backgroundColor: COLOURS.panelBg,
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
  },
  kvRow: {
    flexDirection: "row",
    paddingVertical: 2,
  },
  kvLabel: { flex: 4, color: COLOURS.ink },
  kvValue: { flex: 6, fontFamily: "Helvetica-Bold" },
  hr: { height: 0.5, backgroundColor: COLOURS.divider, marginVertical: 6 },

  // PCB2(II) monthly table
  pcbTableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: COLOURS.rule,
    paddingVertical: 4,
    paddingHorizontal: 2,
    fontFamily: "Helvetica-Bold",
    fontSize: 8.5,
    backgroundColor: COLOURS.panelBg,
  },
  pcbTableRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: COLOURS.divider,
    paddingVertical: 3,
    paddingHorizontal: 2,
    fontSize: 8.5,
  },
  pcbTableTotal: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: COLOURS.rule,
    paddingVertical: 4,
    paddingHorizontal: 2,
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    marginTop: 2,
  },
  colMonth: { flex: 1.5 },
  colAmount: { flex: 1.4, textAlign: "right" },
  colReceipt: { flex: 2 },
  colDate: { flex: 1.5 },

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
  signatureBlock: {
    marginTop: 22,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  signatureCol: { flex: 1, marginRight: 12 },
  signatureLine: {
    marginTop: 36,
    borderTopWidth: 0.5,
    borderTopColor: COLOURS.ink,
    paddingTop: 4,
    fontSize: 8.5,
  },
  closingNote: {
    marginTop: 14,
    fontSize: 8.5,
    color: COLOURS.muted,
    lineHeight: 1.4,
  },
})

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

function fmtRm(v: number | null | undefined): string {
  if (v == null) return ""
  return new Intl.NumberFormat("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v)
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/**
 * Shared header rendered at the top of every employee form. Shows
 * AltomateHR branding on the left + the LHDN form code on the right
 * so the page is identifiable at a glance.
 */
function BrandHeader(props: {
  payload: EmployeeFormPayload
  formCode: string
  formCodeSub?: string
}) {
  const employer = props.payload.employer
  return (
    <View style={styles.brandBlock}>
      <View style={styles.brandLeft}>
        <Text style={styles.brandName}>
          {employer.employerName ?? props.payload.organizationName}
        </Text>
        {employer.fullAddress ? (
          <Text style={styles.brandSub}>{employer.fullAddress}</Text>
        ) : null}
        <Text style={styles.brandSub}>
          {employer.employerTin
            ? `Employer No. (E): ${employer.employerTin}`
            : "Employer No. (E): —"}
          {employer.phone ? `   Tel: ${employer.phone}` : ""}
          {employer.email ? `   Email: ${employer.email}` : ""}
        </Text>
      </View>
      <View style={styles.brandRight}>
        <Text style={styles.formCode}>{props.formCode}</Text>
        {props.formCodeSub ? (
          <Text style={styles.formCodeSub}>{props.formCodeSub}</Text>
        ) : null}
      </View>
    </View>
  )
}

function KvRow(props: { label: string; value: string }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{props.label}</Text>
      <Text style={styles.kvValue}>{props.value || "—"}</Text>
    </View>
  )
}

// ─── 1. PCB 2(II) — Statement of payment by employer ────────────────────

export type FormPcb2IiPdfDocumentProps = {
  payload: EmployeeFormPayload
  generatedAt: Date
}

/**
 * PCB 2(II) — STATEMENT OF PAYMENT BY EMPLOYER
 *
 * Section layout mirrors LHDN's PCB 2(II)-Pin. 2012:
 *   1. Header block — addressed to "Chief Executive Officer / Director
 *      General Inland Revenue, IRBM Branch", with generation date.
 *   2. Employee identification — name, IC, TIN, staff no., employer's E.
 *   3. Section 2: monthly MTD + CP38 table for the current year.
 *   4. Section 3: deductions for preceding-year income paid in this
 *      year (left blank in v1 — we don't track this separately yet).
 *   5. Authorised officer block + employer name + address.
 *
 * Receipt / Bank Slip / Transaction columns are intentionally left
 * blank: the admin fills them in by hand from their bank slips after
 * paying LHDN, so the PDF acts as a template. This matches the
 * official form's expectations.
 */
export function FormPcb2IiPdfDocument(props: FormPcb2IiPdfDocumentProps) {
  const { payload } = props
  const { employee, employer, year, perMonth } = payload

  const totalMtd = perMonth.reduce((s, m) => s + (m?.mtd ?? 0), 0)
  const totalCp38 = perMonth.reduce((s, m) => s + (m?.cp38 ?? 0), 0)

  return (
    <Document title={`PCB2II ${year} ${employee.name}`} author={payload.organizationName}>
      <Page size="A4" style={styles.page}>
        <BrandHeader
          payload={payload}
          formCode="PCB 2(II)"
          formCodeSub="Pin. 2012"
        />

        <View style={styles.titleBlock}>
          <Text style={styles.formTitle}>STATEMENT OF PAYMENT BY EMPLOYER</Text>
          <Text style={styles.formSubtitle}>Penyata Pembayaran Oleh Majikan</Text>
          <Text style={styles.formSubtitle}>
            Tax Deduction Made During The Year {year}
          </Text>
        </View>

        {/* Letter-style intro mirroring the official form */}
        <Text style={{ fontSize: 9, lineHeight: 1.5 }}>
          To: Chief Executive Officer / Director General Inland Revenue{"\n"}
          Inland Revenue Board Of Malaysia{"\n"}
          Branch: ____________________________________{"  "}
          Date: {fmtDate(props.generatedAt)}
        </Text>

        <Text style={[styles.sectionHeader, { marginTop: 14 }]}>
          1. Employee Identification
        </Text>
        <KvRow label="Name of Employee / Nama Pekerja" value={employee.name} />
        <KvRow
          label="New Identity Card No. / Passport No."
          value={employee.idNumber ?? ""}
        />
        <KvRow
          label="Employee Income Tax No. (TIN)"
          value={employee.incomeTaxNumber ?? ""}
        />
        <KvRow label="Staff No." value={employee.employeeCode} />
        <KvRow
          label="Employer's No. (E)"
          value={employer.employerTin ?? ""}
        />

        <Text style={styles.sectionHeader}>
          2. Deductions Made During The Year {year}
        </Text>
        <View style={styles.pcbTableHeader}>
          <Text style={styles.colMonth}>Month</Text>
          <Text style={styles.colAmount}>MTD (RM)</Text>
          <Text style={styles.colAmount}>CP38 (RM)</Text>
          <Text style={styles.colReceipt}>Receipt / Bank Slip No.</Text>
          <Text style={styles.colDate}>Receipt Date</Text>
        </View>
        {perMonth.map((m, idx) => (
          <View key={idx} style={styles.pcbTableRow}>
            <Text style={styles.colMonth}>{MONTH_NAMES[idx]}</Text>
            <Text style={styles.colAmount}>{m ? fmtRm(m.mtd) : ""}</Text>
            <Text style={styles.colAmount}>{m ? fmtRm(m.cp38) : ""}</Text>
            {/* Receipt + date columns intentionally blank — admin
                fills these in by hand from their LHDN payment slips. */}
            <Text style={styles.colReceipt}></Text>
            <Text style={styles.colDate}></Text>
          </View>
        ))}
        <View style={styles.pcbTableTotal}>
          <Text style={styles.colMonth}>Total</Text>
          <Text style={styles.colAmount}>{fmtRm(totalMtd)}</Text>
          <Text style={styles.colAmount}>{fmtRm(totalCp38)}</Text>
          <Text style={styles.colReceipt}></Text>
          <Text style={styles.colDate}></Text>
        </View>

        <Text style={styles.sectionHeader}>
          3. Deductions for Preceding-Year Income Paid In {year}
        </Text>
        <Text style={{ fontSize: 8.5, color: COLOURS.muted, marginBottom: 4 }}>
          Fill in by hand if any preceding-year income was paid out (e.g.
          arrears, late bonus) in {year}. AltomateHR does not track these
          separately from the current-year run.
        </Text>
        <View style={styles.pcbTableHeader}>
          <Text style={{ flex: 1.5 }}>Type of Income</Text>
          <Text style={{ flex: 1 }}>Month</Text>
          <Text style={{ flex: 1 }}>Year</Text>
          <Text style={styles.colAmount}>MTD (RM)</Text>
          <Text style={styles.colReceipt}>Receipt / Slip No.</Text>
          <Text style={styles.colDate}>Date</Text>
        </View>
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.pcbTableRow}>
            <Text style={{ flex: 1.5 }}></Text>
            <Text style={{ flex: 1 }}></Text>
            <Text style={{ flex: 1 }}></Text>
            <Text style={styles.colAmount}></Text>
            <Text style={styles.colReceipt}></Text>
            <Text style={styles.colDate}></Text>
          </View>
        ))}

        <View style={styles.signatureBlock}>
          <View style={styles.signatureCol}>
            <Text style={{ fontSize: 8.5, color: COLOURS.muted }}>
              Name of Officer:
            </Text>
            <Text style={styles.signatureLine}>
              {employer.declarantName ?? ""}
            </Text>
            <Text style={{ fontSize: 8.5, color: COLOURS.muted, marginTop: 6 }}>
              Designation:
            </Text>
            <Text style={styles.signatureLine}>
              {employer.declarantPosition ?? ""}
            </Text>
            <Text style={{ fontSize: 8.5, color: COLOURS.muted, marginTop: 6 }}>
              Telephone No.:
            </Text>
            <Text style={styles.signatureLine}>{employer.phone ?? ""}</Text>
          </View>
          <View style={styles.signatureCol}>
            <Text style={{ fontSize: 8.5, color: COLOURS.muted }}>
              Name and Address of Employer:
            </Text>
            <Text style={styles.signatureLine}>
              {employer.employerName ?? ""}
            </Text>
            <Text style={{ fontSize: 8.5, color: COLOURS.muted, marginTop: 6 }}>
              {employer.fullAddress ?? ""}
            </Text>
          </View>
        </View>

        <Text style={styles.closingNote}>
          Generated by AltomateHR on {fmtDate(props.generatedAt)}. This
          summary is a working document — transcribe the values onto the
          official LHDN PCB 2(II) form before submission. Receipt /
          bank-slip numbers can be filled in by hand once the underlying
          MTD payment has cleared.
        </Text>

        <View style={styles.footer} fixed>
          <Text>
            PCB 2(II) · {year} · {employer.employerName ?? payload.organizationName} ·{" "}
            {employee.name}
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
