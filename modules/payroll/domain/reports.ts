/**
 * Domain types + metadata for the downloadable per-run payroll reports
 * surfaced by the "Download files" modal on the run detail page.
 *
 * Bank disbursement: exactly ONE bank file is offered per run — the one
 * matching the company's configured payroll bank (see
 * `PAYROLL_FILE_FORMAT_TO_KIND`). There is no generic fallback; a bank
 * we have no format for simply isn't selectable in payroll settings.
 *
 * Pure domain layer — no Prisma, no `server-only`. Both the modal
 * (client) and the generator service (server) consume these.
 */

import type { PayrollFileFormat } from "@/modules/payroll/domain/malaysian-banks"

/**
 * One of the 7 cached report kinds. Mirrors `PayrollReportKind` in the
 * Prisma schema. (Kept as a local string union so the client can use it
 * without pulling the Prisma client into the bundle.)
 */
export const payrollReportKinds = [
  "PAYROLL_SUMMARY_PDF",
  "PAYMENT_SCHEDULE_PDF",
  // LHDN MTD Specification 2026 worksheet — each employee's PCB
  // calculation shown LHDN-form-style with the dark blue header bar,
  // numbered sections (PCB(A) Normal / Yearly PCB / Yearly Tax / AR
  // PCB / Net PCB), and each variable in its own table card showing
  // abbreviation + full official LHDN description + amount. Audit-
  // ready format; auditors familiar with the LHDN form will read it
  // without any explanation. SUPERSEDES the older compact
  // "Detailed Calculations" PDF (which was removed from the modal in
  // 2026-06 — the Prisma enum value DETAILED_CALCULATIONS_PDF stays
  // for back-compat with existing PayrollRunReport cache rows but
  // is no longer rendered).
  "PCB_LHDN_FORM_PDF",
  "BULK_PAYSLIPS_PDF",
  "EPF_CSV",
  "SOCSO_EIS_TXT",
  "SOCSO_EIS_SKBBK_TXT",
  "PCB_TXT",
  "BANK_PB_ECP_XLSX",
  "BANK_MBB_M2E_TXT",
  "BANK_CIMB_BIZCHANNEL_TXT",
] as const

export type PayrollReportKind = (typeof payrollReportKinds)[number]

/**
 * Which report kind implements each bank's bulk-payroll format. The
 * company's disbursement bank resolves to a `PayrollFileFormat`, and
 * this maps that to the downloadable report — so adding a bank means
 * adding a renderer + one row here, nothing else.
 */
export const PAYROLL_FILE_FORMAT_TO_KIND: Record<
  PayrollFileFormat,
  PayrollReportKind
> = {
  PB_ECP_XLSX: "BANK_PB_ECP_XLSX",
  MBB_M2E_TXT: "BANK_MBB_M2E_TXT",
  CIMB_BIZCHANNEL_TXT: "BANK_CIMB_BIZCHANNEL_TXT",
}

/**
 * Grouping shown as a section header in the modal:
 *   - REPORTS — internal documents the admin keeps for management.
 *   - STATUTORY — files the admin uploads to government portals.
 *   - PAYSLIPS — bulk payslip PDF for distribution to employees.
 *   - BANK — bank disbursement upload files (PB ECP, etc.).
 */
export type PayrollReportGroup = "REPORTS" | "STATUTORY" | "PAYSLIPS" | "BANK"

export type PayrollReportMeta = {
  kind: PayrollReportKind
  group: PayrollReportGroup
  /// Short title shown as the row label.
  title: string
  /// One-line description shown under the title.
  description: string
  /// Hint of which portal/system this file uploads to, when applicable.
  portal: string | null
  /// File extension (without the dot).
  extension: "pdf" | "csv" | "txt" | "xlsx" | "zip"
  /// MIME type written to disk + sent on the download response.
  mimeType: string
}

/**
 * Static metadata for every report kind. Iterate this to render the
 * modal — no other list/map needs maintaining.
 */
export const PAYROLL_REPORT_META: Record<PayrollReportKind, PayrollReportMeta> = {
  PAYROLL_SUMMARY_PDF: {
    kind: "PAYROLL_SUMMARY_PDF",
    group: "REPORTS",
    title: "Payroll Summary",
    description:
      "Internal one-pager of run totals — gross, net, EPF, SOCSO, EIS, PCB, HRDF, headcount.",
    portal: null,
    extension: "pdf",
    mimeType: "application/pdf",
  },
  PAYMENT_SCHEDULE_PDF: {
    kind: "PAYMENT_SCHEDULE_PDF",
    group: "REPORTS",
    title: "Payment Schedule",
    description:
      "Per-employee net pay + statutory remittances (PCB, EPF, SOCSO, EIS, HRDF).",
    portal: null,
    extension: "pdf",
    mimeType: "application/pdf",
  },
  PCB_LHDN_FORM_PDF: {
    kind: "PCB_LHDN_FORM_PDF",
    group: "REPORTS",
    title: "PCB Calculation Details (ZIP of LHDN forms)",
    description:
      "LHDN MTD §E worksheet for each employee — numbered sections with the official LHDN variable descriptions, audit-ready. ZIP bundles one PDF per employee so finance can forward individual worksheets directly.",
    portal: null,
    extension: "zip",
    mimeType: "application/zip",
  },
  EPF_CSV: {
    kind: "EPF_CSV",
    group: "STATUTORY",
    title: "EPF Contribution CSV",
    description:
      "Bulk-upload CSV with EPF no, IC, name, wage, and employee/employer contributions.",
    portal: "KWSP i-Akaun (Majikan)",
    extension: "csv",
    mimeType: "text/csv",
  },
  SOCSO_EIS_TXT: {
    kind: "SOCSO_EIS_TXT",
    group: "STATUTORY",
    title: "SOCSO + EIS Contribution TXT (v1)",
    description:
      "Combined SOCSO + EIS upload (278-char fixed-width per PERKESO spec v1.0). Use this for periods before Jun 2026, or during the v1/v2 grace window (Jun-Sep 2026).",
    portal: "PERKESO ASSIST Portal",
    extension: "txt",
    mimeType: "text/plain",
  },
  SOCSO_EIS_SKBBK_TXT: {
    kind: "SOCSO_EIS_SKBBK_TXT",
    group: "STATUTORY",
    title: "SOCSO + EIS + SKBBK Contribution TXT (ASSIST 2.0)",
    description:
      "Combined SOCSO + EIS + SKBBK (LINDUNG 24 Jam) upload (278-char fixed-width per PERKESO ASSIST 2.0 spec). Mandatory from Jun 2026 onward; until then PERKESO accepts either format.",
    portal: "PERKESO ASSIST 2.0 Portal",
    extension: "txt",
    mimeType: "text/plain",
  },
  PCB_TXT: {
    kind: "PCB_TXT",
    group: "STATUTORY",
    title: "PCB / MTD TXT",
    description:
      "Monthly tax deduction remittance (LHDN CP39 fixed-width format).",
    portal: "LHDN e-PCB",
    extension: "txt",
    mimeType: "text/plain",
  },
  BULK_PAYSLIPS_PDF: {
    kind: "BULK_PAYSLIPS_PDF",
    group: "PAYSLIPS",
    title: "Bulk Payslips (ZIP of individual PDFs)",
    description:
      "ZIP containing one PDF per employee — so payroll can forward each payslip individually over chat / email without splitting a combined PDF first.",
    portal: null,
    extension: "zip",
    mimeType: "application/zip",
  },
  BANK_PB_ECP_XLSX: {
    kind: "BANK_PB_ECP_XLSX",
    group: "BANK",
    title: "Public Bank ECP (Bulk Payroll)",
    description:
      "Bulk salary disbursement Excel for upload to PB enterprise → Bulk Payroll. Auto-fills BIC codes from each employee's bank.",
    portal: "PB enterprise (Public Bank)",
    extension: "xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  BANK_MBB_M2E_TXT: {
    kind: "BANK_MBB_M2E_TXT",
    group: "BANK",
    title: "Maybank M2E (Bulk Payroll)",
    description:
      "Pipe-delimited bulk salary file for upload to Maybank2E → Bulk Payment. Picks book transfer (IT) for Maybank accounts and IBG (IG) for other banks automatically.",
    portal: "Maybank2E",
    extension: "txt",
    mimeType: "text/plain",
  },
  BANK_CIMB_BIZCHANNEL_TXT: {
    kind: "BANK_CIMB_BIZCHANNEL_TXT",
    group: "BANK",
    title: "CIMB BizChannel (Bulk Payroll)",
    description:
      "Fixed-width bulk salary file for upload to BizChannel@CIMB \u2192 Bulk Payments \u2192 Payroll (TXT, Non Encrypted). Fills each employee's BNM bank code automatically.",
    portal: "BizChannel@CIMB",
    extension: "txt",
    mimeType: "text/plain",
  },
}

export const PAYROLL_REPORT_GROUP_LABELS: Record<PayrollReportGroup, string> = {
  REPORTS: "Reports",
  STATUTORY: "Statutory uploads",
  PAYSLIPS: "Payslips",
  BANK: "Bank disbursement",
}

/**
 * Build the user-facing filename for a report. Same pattern as the
 * original Altomate exports: `<Title>_<Month>_<Year>.<ext>`.
 *
 * Examples:
 *   - `Payroll_Summary_January_2026.pdf`
 *   - `SOCSO_EIS_012026.txt`
 *   - `PCB_012026.txt`
 *   - `EPF_iAkaun-2026_01.csv`
 */
const MONTHS = [
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
] as const

export function buildReportFileName(input: {
  kind: PayrollReportKind
  periodYear: number
  periodMonth: number // 1..12
  /// ISO date of generation — only used by EPF CSV (date prefix).
  generatedAt?: Date
}): string {
  const meta = PAYROLL_REPORT_META[input.kind]
  const monthName = MONTHS[input.periodMonth - 1] ?? "Unknown"
  const mm = String(input.periodMonth).padStart(2, "0")
  const yy = String(input.periodYear)
  const mmyyyy = `${mm}${yy}`

  switch (input.kind) {
    case "PAYROLL_SUMMARY_PDF":
      return `Payroll_Summary_${monthName}_${yy}.${meta.extension}`
    case "PAYMENT_SCHEDULE_PDF":
      return `Payment_Schedule_${monthName}_${yy}.${meta.extension}`
    case "PCB_LHDN_FORM_PDF":
      return `PCB_Calculation_Details_${monthName}_${yy}.${meta.extension}`
    case "BULK_PAYSLIPS_PDF":
      // Extension is now `.zip`; legacy filename pattern preserved
      // (`Payslips_YYYY_MM_All.zip`) so admins recognise the bundle.
      return `Payslips_${yy}_${mm}_All.${meta.extension}`
    case "EPF_CSV": {
      const d = input.generatedAt ?? new Date()
      const dd = String(d.getDate()).padStart(2, "0")
      const m = String(d.getMonth() + 1).padStart(2, "0")
      const y = String(d.getFullYear())
      // `{DDMMYYYY}-EPF_iAkaun-{YYYY}_{MM}.csv`
      return `${dd}${m}${y}-EPF_iAkaun-${yy}_${mm}.${meta.extension}`
    }
    case "SOCSO_EIS_TXT":
      return `SOCSO_EIS_${mmyyyy}.${meta.extension}`
    case "SOCSO_EIS_SKBBK_TXT":
      return `SOCSO_EIS_SKBBK_${mmyyyy}.${meta.extension}`
    case "PCB_TXT":
      return `PCB_${mmyyyy}.${meta.extension}`
    case "BANK_PB_ECP_XLSX":
      // PB ECP filename format: `<10-digit account>PR<DDMMYY><NN>.xlsx`.
      // The account number isn't available in this pure-domain
      // function, so we return a placeholder; the service overrides
      // the filename with the real PB filename at generation time
      // (see `pb-ecp-xlsx.ts → buildPbEcpFileName`).
      return `PB_ECP_Payroll_${mmyyyy}.${meta.extension}`
    case "BANK_MBB_M2E_TXT":
      return `MBB_M2E_Payroll_${mmyyyy}.${meta.extension}`
    case "BANK_CIMB_BIZCHANNEL_TXT":
      return `CIMB_Payroll_${mmyyyy}.${meta.extension}`
  }
}

/**
 * Row shape returned by the repo / service for the modal — combines
 * the static meta with the per-run "is it generated yet" state.
 */
export type PayrollReportRow = PayrollReportMeta & {
  /// Null when the file hasn't been generated yet.
  generated: {
    fileName: string
    fileUrl: string
    sizeBytes: number
    generatedAt: string // ISO
  } | null
}
