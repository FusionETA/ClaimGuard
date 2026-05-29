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

const MARITAL_STATUS_LABELS_BILINGUAL: Record<string, string> = {
  SINGLE: "Single / Bujang",
  MARRIED: "Married / Berkahwin",
  DIVORCED: "Divorced / Bercerai",
  WIDOWED: "Widowed / Balu",
  SEPARATED: "Separated / Berpisah",
}

const GENDER_LABELS_BILINGUAL: Record<string, string> = {
  MALE: "Male / Lelaki",
  FEMALE: "Female / Perempuan",
  OTHER: "Other / Lain-lain",
}

const ID_TYPE_LABELS_BILINGUAL: Record<string, string> = {
  NRIC: "NRIC / Kad Pengenalan",
  PASSPORT: "Passport / Pasport",
  ARMY_NO: "Army No. / No. Tentera",
  POLICE_NO: "Police No. / No. Polis",
}

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

/**
 * Two-column KV row, used when LHDN's form lays out fields side by
 * side (e.g. B12 Residential / B13 Correspondence on CP22).
 */
function KvRowDual(props: {
  leftLabel: string
  leftValue: string
  rightLabel: string
  rightValue: string
}) {
  return (
    <View style={[styles.kvRow, { gap: 12 }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: COLOURS.muted, fontSize: 8.5 }}>
          {props.leftLabel}
        </Text>
        <Text style={{ fontFamily: "Helvetica-Bold", marginTop: 1 }}>
          {props.leftValue || "—"}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: COLOURS.muted, fontSize: 8.5 }}>
          {props.rightLabel}
        </Text>
        <Text style={{ fontFamily: "Helvetica-Bold", marginTop: 1 }}>
          {props.rightValue || "—"}
        </Text>
      </View>
    </View>
  )
}

/**
 * Amount row used in the D-section remuneration breakdown on CP22 /
 * CP22A / CP21. Left label, right RM amount. `bold` highlights the
 * sub-total row.
 */
function AmtRow(props: {
  label: string
  amount: number | null
  bold?: boolean
}) {
  const fmt = props.amount == null ? "" : fmtRm(props.amount)
  return (
    <View
      style={[
        styles.kvRow,
        props.bold ? { borderTopWidth: 0.5, borderTopColor: COLOURS.rule } : {},
      ]}
    >
      <Text
        style={[
          { flex: 5 },
          props.bold ? { fontFamily: "Helvetica-Bold" } : {},
        ]}
      >
        {props.label}
      </Text>
      <Text
        style={[
          { flex: 2, textAlign: "right" },
          { fontFamily: "Helvetica-Bold" },
        ]}
      >
        {fmt}
      </Text>
    </View>
  )
}

/**
 * Inline "[ ] Option A    [X] Option B" picker, used on CP22A / CP21
 * for the Yes/No and Mandatory/Optional toggles. Selected option is
 * drawn with a filled square; everything else stays empty.
 */
function CheckOptions(props: {
  options: Array<{ label: string; selected: boolean }>
}) {
  return (
    <View style={{ flexDirection: "row", gap: 14 }}>
      {props.options.map((opt, i) => (
        <Text key={i}>
          {opt.selected ? "[X]" : "[ ]"} {opt.label}
        </Text>
      ))}
    </View>
  )
}

/**
 * Multi-line address block — pulls together the address lines that
 * exist, joined by line breaks. Empty when all parts are blank.
 */
function joinAddress(parts: Array<string | null | undefined>): string {
  const cleaned = parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
  return cleaned.length === 0 ? "" : cleaned.join("\n")
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

// ─── 2. CP22 — Notification of new employee ─────────────────────────────

export type FormCp22PdfDocumentProps = {
  payload: EmployeeFormPayload
  generatedAt: Date
}

/**
 * CP22 — Notification by employer of new employee.
 *
 * LHDN-mandated within 30 days of the join date for any employee
 * subject to tax. Layout mirrors CP22 [Pin.1/2021]:
 *
 *   A. Employer particulars (in BrandHeader)
 *   B. New employee particulars (identification + contact + employment)
 *   C. Spouse particulars (if married)
 *   D. Monthly remuneration breakdown
 *   E. Previous employer in Malaysia
 *   F. Authorised officer declaration
 *
 * Fields like "Expected duration of employment" and "Nature of
 * employment" are admin-entered and we don't store them — they render
 * as labelled blank lines for HR to fill in by hand.
 */
export function FormCp22PdfDocument(props: FormCp22PdfDocumentProps) {
  const { payload } = props
  const { employee, employer } = payload

  return (
    <Document title={`CP22 ${employee.name}`} author={payload.organizationName}>
      <Page size="A4" style={styles.page}>
        <BrandHeader
          payload={payload}
          formCode="CP22"
          formCodeSub="Pin.1/2021"
        />

        <View style={styles.titleBlock}>
          <Text style={styles.formTitle}>
            NOTIFICATION OF NEW EMPLOYEE BY EMPLOYER
          </Text>
          <Text style={styles.formSubtitle}>
            Borang Pemberitahuan Oleh Majikan Bagi Pekerja Baharu
          </Text>
          <Text style={styles.formSubtitle}>
            Subsection 83(2) of the Income Tax Act 1967
          </Text>
          <Text style={[styles.formSubtitle, { marginTop: 4 }]}>
            Submit within 30 days from the date of commencement of employment
          </Text>
        </View>

        <Text style={styles.sectionHeader}>
          B. New Employee Particulars / Maklumat Pekerja Baharu
        </Text>
        <KvRow label="B1. Full name / Nama penuh" value={employee.name} />
        <KvRowDual
          leftLabel="B2. Income tax no. (TIN)"
          leftValue={employee.incomeTaxNumber ?? ""}
          rightLabel="B3. Identification no."
          rightValue={employee.idNumber ?? ""}
        />
        <KvRowDual
          leftLabel="B4. Current passport no."
          leftValue={
            employee.idType === "PASSPORT" ? (employee.idNumber ?? "") : ""
          }
          rightLabel="B5. Passport registered with IRBM"
          rightValue=""
        />
        <KvRowDual
          leftLabel="B6. Citizenship / Warganegara"
          leftValue={employee.nationality ?? ""}
          rightLabel="B7. Gender / Jantina"
          rightValue={
            employee.gender
              ? (GENDER_LABELS_BILINGUAL[employee.gender] ?? employee.gender)
              : ""
          }
        />
        <KvRowDual
          leftLabel="B8. Date of birth / Tarikh lahir"
          leftValue={employee.dateOfBirth ? fmtDate(employee.dateOfBirth) : ""}
          rightLabel="B9. Marital status / Status perkahwinan"
          rightValue={
            employee.maritalStatus
              ? (MARITAL_STATUS_LABELS_BILINGUAL[employee.maritalStatus] ??
                employee.maritalStatus)
              : ""
          }
        />
        <KvRowDual
          leftLabel="B10. Telephone no."
          leftValue={employee.phone ?? ""}
          rightLabel="B11. E-mail"
          rightValue={employee.alternateEmail ?? employee.email}
        />
        <KvRowDual
          leftLabel="B12. Current residential address"
          leftValue={joinAddress([
            employee.addressLine1,
            employee.addressLine2,
            employee.addressLine3,
            [employee.postcode, employee.city]
              .filter(Boolean)
              .join(" ")
              .trim() || null,
            employee.state,
          ])}
          rightLabel="B13. Correspondence address (same if blank)"
          rightValue=""
        />
        <KvRowDual
          leftLabel="B14. Commencement date"
          leftValue={employee.joinDate ? fmtDate(employee.joinDate) : ""}
          rightLabel="B15. Designation / Jawatan"
          rightValue={employee.jobTitle ?? ""}
        />
        <KvRowDual
          leftLabel="B16. Expected duration of employment"
          leftValue=""
          rightLabel="B17. Nature of employment / Jenis pekerjaan"
          rightValue=""
        />
        <Text style={{ fontSize: 8.5, color: COLOURS.muted, marginTop: 3 }}>
          B16/B17 are not tracked in payroll. Fill in by hand
          (e.g. &quot;Permanent / Tetap&quot;, &quot;Contract / Kontrak&quot;).
        </Text>

        <Text style={styles.sectionHeader}>
          C. Spouse Particulars (If Married) / Maklumat Suami Isteri
        </Text>
        <KvRow label="C1. Spouse full name" value="" />
        <KvRowDual
          leftLabel="C2. Spouse ID / passport no."
          leftValue={employee.spouseIdNumber ?? ""}
          rightLabel="C3. Spouse income tax no."
          rightValue={employee.spousePcbNumber ?? ""}
        />
        <KvRow label="C4. Spouse telephone no." value="" />

        <Text style={styles.sectionHeader}>
          D. Monthly Remuneration / Maklumat Saraan Bulanan
        </Text>
        <AmtRow
          label="D1. Salary, wages, overtime / Gaji, upah, kerja lebih masa"
          amount={employee.monthlySalary}
        />
        <AmtRow label="D2. Leave pay / Gaji cuti" amount={null} />
        <AmtRow label="D3. Commission and bonus / Komisen dan bonus" amount={null} />
        <AmtRow
          label="D4. Cash allowances incl. tax borne by employer"
          amount={null}
        />
        <AmtRow
          label="D5. Benefits-in-kind (BIK) subject to tax"
          amount={null}
        />
        <AmtRow
          label="D6. Value of employer-provided accommodation"
          amount={null}
        />
        <AmtRow
          label="D7. Allowances in kind (food, clothing, lodging, servants)"
          amount={null}
        />
        <AmtRow label="D8. Other payments / Bayaran-bayaran lain" amount={null} />
        <AmtRow
          label="TOTAL / JUMLAH"
          amount={employee.monthlySalary ?? 0}
          bold
        />
        <Text style={{ fontSize: 8.5, color: COLOURS.muted, marginTop: 3 }}>
          Only D1 is auto-filled from the employee&apos;s salary record.
          Add D2–D8 by hand if applicable.
        </Text>

        <Text style={styles.sectionHeader}>
          E. Previous Employer in Malaysia / Majikan Terdahulu
        </Text>
        <KvRow label="E1. Employer name" value="" />
        <KvRow label="E2. Employer address" value="" />

        <Text style={styles.sectionHeader}>
          F. Authorised Officer Declaration / Akuan Pegawai
        </Text>
        <View style={styles.signatureBlock}>
          <View style={styles.signatureCol}>
            <Text style={{ fontSize: 8.5, color: COLOURS.muted }}>
              Name / Nama:
            </Text>
            <Text style={styles.signatureLine}>
              {employer.declarantName ?? ""}
            </Text>
            <Text style={{ fontSize: 8.5, color: COLOURS.muted, marginTop: 6 }}>
              ID / passport no.:
            </Text>
            <Text style={styles.signatureLine}>
              {employer.declarantIdNumber ?? ""}
            </Text>
          </View>
          <View style={styles.signatureCol}>
            <Text style={{ fontSize: 8.5, color: COLOURS.muted }}>
              Designation / Jawatan:
            </Text>
            <Text style={styles.signatureLine}>
              {employer.declarantPosition ?? ""}
            </Text>
            <Text style={{ fontSize: 8.5, color: COLOURS.muted, marginTop: 6 }}>
              Date / Tarikh:
            </Text>
            <Text style={styles.signatureLine}>{fmtDate(props.generatedAt)}</Text>
          </View>
        </View>

        <Text style={styles.closingNote}>
          Generated by AltomateHR on {fmtDate(props.generatedAt)}. Transcribe
          onto the official LHDN CP22 form before submission. Submit
          within 30 days of {employee.joinDate ? fmtDate(employee.joinDate) : "the commencement date"}.
        </Text>

        <View style={styles.footer} fixed>
          <Text>
            CP22 · {employer.employerName ?? payload.organizationName} ·{" "}
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
