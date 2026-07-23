/**
 * Annual tax-form PDF documents — rendered via `@react-pdf/renderer`.
 *
 *   1. `FormEaBulkPdfDocument`
 *      — One Form EA per employee, concatenated. Distributed to
 *        employees by 28 Feb of the following year.
 *
 *   2. `FormECp8dPdfDocument`
 *      — Employer's annual return (Form E) cover page + CP8D table.
 *
 * Visual style intentionally minimal — these are statutory forms, so
 * clarity beats decoration. The layout mirrors the section headings
 * on the real LHDN forms so admins can cross-check.
 */

import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer"

import type {
  AnnualEmployeeAggregate,
  AnnualPayrollPayload,
} from "@/modules/payroll/application/services/report-renderers/annual-shared"

const COLOURS = {
  ink: "#0f172a",
  muted: "#64748b",
  faint: "#94a3b8",
  divider: "#e2e8f0",
  rule: "#cbd5e1",
  panelBg: "#f8fafc",
  emerald: "#047857",
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
  titleBlock: {
    alignItems: "center",
    marginBottom: 14,
  },
  formTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 14,
    letterSpacing: 2,
  },
  formSubtitle: {
    marginTop: 2,
    fontSize: 10,
    color: COLOURS.muted,
    textAlign: "center",
  },
  sectionHeader: {
    marginTop: 14,
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
  kvValue: {
    flex: 5,
    fontFamily: "Helvetica-Bold",
  },
  kvAmount: {
    flex: 2,
    textAlign: "right",
    fontFamily: "Helvetica-Bold",
  },
  hr: {
    height: 0.5,
    backgroundColor: COLOURS.divider,
    marginVertical: 6,
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

  // CP8D table
  cp8dHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: COLOURS.rule,
    paddingVertical: 4,
    paddingHorizontal: 2,
    fontFamily: "Helvetica-Bold",
    fontSize: 8.5,
  },
  cp8dRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: COLOURS.divider,
    paddingVertical: 3,
    paddingHorizontal: 2,
    fontSize: 8.5,
  },
  cp8dCellNo: { width: 22 },
  cp8dCellName: { flex: 3 },
  cp8dCellTaxNo: { flex: 1.6 },
  cp8dCellIc: { flex: 1.6 },
  cp8dCellAmount: { flex: 1.2, textAlign: "right" },
})

function fmtRm(v: number | null | undefined): string {
  return new Intl.NumberFormat("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v ?? 0)
}

function fmtInt(v: number | null | undefined): string {
  return new Intl.NumberFormat("en-MY", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(v ?? 0))
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

// ─── 1. Form EA Bulk ─────────────────────────────────────────────────────

export type FormEaBulkPdfDocumentProps = {
  payload: AnnualPayrollPayload
  generatedAt: Date
}

export function FormEaBulkPdfDocument(props: FormEaBulkPdfDocumentProps) {
  const { payload } = props

  return (
    <Document
      title={`Form EA ${payload.year} (Bulk)`}
      author={payload.organizationName}
    >
      {payload.employees.map((e) => (
        <Page key={e.payrollProfileId || e.employeeProfileId} size="A4" style={styles.page}>
          <View style={styles.titleBlock}>
            <Text style={styles.formTitle}>EA</Text>
            <Text style={styles.formSubtitle}>
              PENYATA SARAAN DARIPADA PENGGAJIAN BAGI TAHUN BERAKHIR 31 DISEMBER{" "}
              {payload.year}
            </Text>
            <Text style={[styles.formSubtitle, { marginTop: 8 }]}>
              {payload.companyInfo?.employerName ?? payload.organizationName}
              {payload.companyInfo?.employerTin
                ? ` · ${payload.companyInfo.employerTin}`
                : ""}
            </Text>
          </View>

          <Text style={styles.sectionHeader}>A. Particulars of Employee</Text>
          <KvRow label="Name" value={e.employeeName} />
          <KvRow label="Position" value={e.jobTitle ?? "—"} />
          <KvRow label="IC No. (New)" value={e.idNumber ?? "—"} />
          <KvRow label="Income Tax No." value={e.incomeTaxNumber ?? "—"} />
          <KvRow label="EPF No." value={e.epfNumber ?? "—"} />
          <KvRow label="SOCSO No." value={e.socsoNumber ?? "—"} />
          <KvRow label="Employee ID" value={e.employeeCode} />

          <Text style={styles.sectionHeader}>B. Income from Employment</Text>
          <AmtRow label="Gross salary / wages / overtime" amount={e.grossSalary} />
          <AmtRow
            label="Bonus / commission / fees / arrears"
            amount={e.bonusAndCommission}
          />
          <AmtRow label="Benefits-in-kind (BIK)" amount={e.totalBik} />
          <View style={styles.hr} />
          <AmtRow
            label="Total income (B + commission + BIK)"
            amount={e.grossSalary + e.bonusAndCommission + e.totalBik}
            bold
          />

          <Text style={styles.sectionHeader}>D. Total Deductions</Text>
          <AmtRow label="PCB / MTD paid to LHDN" amount={e.totalPcb} />
          <AmtRow label="CP38 (court orders)" amount={e.totalCp38} />
          <AmtRow label="Zakat (via payroll)" amount={e.totalZakat} />

          <Text style={styles.sectionHeader}>E. Employee Contributions</Text>
          <AmtRow label="EPF (employee share)" amount={e.totalEpfEmployee} />
          <AmtRow
            label="SOCSO + EIS (employee share)"
            amount={e.totalSocsoEmployee + e.totalEisEmployee}
          />
          {/* SKBBK (Skim LINDUNG 24 Jam, employee-only PERKESO scheme
              effective Jun 2026) shares the RM 350/year K1 relief cap
              with SOCSO + EIS. Shown as a separate line so the
              employee can transcribe the exact figure onto their
              personal-tax filing. Hidden when zero so years before
              Jun 2026 don't show a junk RM 0.00 line. */}
          {e.totalSkbbkEmployee > 0 ? (
            <AmtRow
              label="SKBBK — LINDUNG 24 Jam (employee share)"
              amount={e.totalSkbbkEmployee}
            />
          ) : null}

          <Text style={[styles.formSubtitle, { marginTop: 18 }]}>
            Issued by employer on {fmtDate(props.generatedAt)}. For tax filing
            of year of assessment {payload.year}.
          </Text>

          <View style={styles.footer} fixed>
            <Text>
              Form EA · {payload.year} · {payload.companyInfo?.employerName ?? payload.organizationName}
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

function KvRow(props: { label: string; value: string }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvLabel}>{props.label}</Text>
      <Text style={styles.kvValue}>{props.value}</Text>
    </View>
  )
}

function AmtRow(props: { label: string; amount: number; bold?: boolean }) {
  return (
    <View style={styles.kvRow}>
      <Text
        style={[
          styles.kvLabel,
          props.bold ? { fontFamily: "Helvetica-Bold" } : {},
        ]}
      >
        {props.label}
      </Text>
      <Text style={styles.kvAmount}>{fmtRm(props.amount)}</Text>
    </View>
  )
}

// ─── 2. Form E + CP8D ────────────────────────────────────────────────────

export type FormECp8dPdfDocumentProps = {
  payload: AnnualPayrollPayload
  /// Aggregated counts used for the Form E PART A cells.
  partA: {
    headcountAtYearEnd: number
    headcountSubjectToMtd: number
    newEmployees: number
  }
  generatedAt: Date
}

export function FormECp8dPdfDocument(props: FormECp8dPdfDocumentProps) {
  const { payload, partA } = props
  const totalEmployees = payload.employees.length
  const grandGross = payload.employees.reduce(
    (s, e) => s + e.grossSalary + e.bonusAndCommission + e.totalBik,
    0,
  )
  const grandEpf = payload.employees.reduce(
    (s, e) => s + e.totalEpfEmployee,
    0,
  )
  const grandPcb = payload.employees.reduce((s, e) => s + e.totalPcb, 0)

  return (
    <Document
      title={`Form E + CP8D ${payload.year}`}
      author={payload.organizationName}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.titleBlock}>
          <Text style={styles.formTitle}>FORM E {payload.year}</Text>
          <Text style={styles.formSubtitle}>RETURN FORM OF EMPLOYER</Text>
        </View>

        <Text style={styles.sectionHeader}>Basic Particulars</Text>
        <KvRow
          label="Employer Name"
          value={payload.companyInfo?.employerName ?? payload.organizationName}
        />
        <KvRow
          label="Employer No. (LHDN E No.)"
          value={payload.companyInfo?.employerTin ?? "—"}
        />
        <KvRow
          label="Registration No."
          value={payload.companyInfo?.registrationNo ?? "—"}
        />
        <KvRow
          label="Email"
          value={payload.companyInfo?.email ?? "—"}
        />
        <KvRow
          label="Phone"
          value={payload.companyInfo?.phone ?? "—"}
        />
        <KvRow
          label="Address"
          value={[
            payload.companyInfo?.addressLine1,
            payload.companyInfo?.addressLine2,
            payload.companyInfo?.city,
            payload.companyInfo?.postcode,
            payload.companyInfo?.state,
            payload.companyInfo?.country,
          ]
            .filter((s) => s && s.trim().length > 0)
            .join(", ")}
        />

        <Text style={styles.sectionHeader}>Part A — Headcount</Text>
        <KvRow
          label={`A1. Number of employees as at 31/12/${payload.year}`}
          value={fmtInt(partA.headcountAtYearEnd)}
        />
        <KvRow
          label="A2. Number of employees subject to MTD"
          value={fmtInt(partA.headcountSubjectToMtd)}
        />
        <KvRow
          label="A3. Number of new employees"
          value={fmtInt(partA.newEmployees)}
        />

        <Text style={styles.sectionHeader}>Summary Totals</Text>
        <AmtRow
          label="Total gross remuneration (incl. bonus + BIK)"
          amount={grandGross}
          bold
        />
        <AmtRow label="Total EPF (employee share)" amount={grandEpf} bold />
        <AmtRow label="Total PCB / MTD" amount={grandPcb} bold />

        <Text style={[styles.formSubtitle, { marginTop: 16 }]}>
          The CP8D schedule of {totalEmployees} employee
          {totalEmployees === 1 ? "" : "s"} follows on the next page.
        </Text>

        <View style={styles.footer} fixed>
          <Text>
            Form E · {payload.year} ·{" "}
            {payload.companyInfo?.employerName ?? payload.organizationName}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `${pageNumber} / ${totalPages}`
            }
          />
        </View>
      </Page>

      {/* CP8D table — page 2 onwards. */}
      <Page size="A4" style={styles.page}>
        <View style={styles.titleBlock}>
          <Text style={styles.formTitle}>CP8D</Text>
          <Text style={styles.formSubtitle}>
            EMPLOYEES&apos; PARTICULARS · YEAR {payload.year}
          </Text>
        </View>

        <View style={styles.cp8dHeader}>
          <Text style={styles.cp8dCellNo}>No</Text>
          <Text style={styles.cp8dCellName}>Name</Text>
          <Text style={styles.cp8dCellTaxNo}>Income Tax No</Text>
          <Text style={styles.cp8dCellIc}>IC No</Text>
          <Text style={styles.cp8dCellAmount}>Gross</Text>
          <Text style={styles.cp8dCellAmount}>EPF</Text>
          <Text style={styles.cp8dCellAmount}>MTD</Text>
        </View>

        {payload.employees.map((e, idx) => (
          <View
            key={e.payrollProfileId || e.employeeProfileId}
            style={styles.cp8dRow}
            wrap={false}
          >
            <Text style={styles.cp8dCellNo}>{idx + 1}</Text>
            <Text style={styles.cp8dCellName}>{e.employeeName}</Text>
            <Text style={styles.cp8dCellTaxNo}>
              {e.incomeTaxNumber ?? "—"}
            </Text>
            <Text style={styles.cp8dCellIc}>{e.idNumber ?? "—"}</Text>
            <Text style={styles.cp8dCellAmount}>
              {fmtInt(e.grossSalary + e.bonusAndCommission + e.totalBik)}
            </Text>
            <Text style={styles.cp8dCellAmount}>
              {fmtInt(e.totalEpfEmployee)}
            </Text>
            <Text style={styles.cp8dCellAmount}>
              {fmtRm(e.totalPcb)}
            </Text>
          </View>
        ))}

        <View style={styles.footer} fixed>
          <Text>
            CP8D · {payload.year} ·{" "}
            {payload.companyInfo?.employerName ?? payload.organizationName}
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

// Suppress unused-import lint
void ({} as AnnualEmployeeAggregate)
