/**
 * Domain types + metadata for the downloadable per-run payroll reports
 * surfaced by the "Download files" modal on the run detail page.
 *
 * Pure domain layer — no Prisma, no `server-only`. Both the modal
 * (client) and the generator service (server) consume these.
 */

/**
 * One of the 7 cached report kinds. Mirrors `PayrollReportKind` in the
 * Prisma schema. (Kept as a local string union so the client can use it
 * without pulling the Prisma client into the bundle.)
 */
export const payrollReportKinds = [
  "PAYROLL_SUMMARY_PDF",
  "PAYMENT_SCHEDULE_PDF",
  "DETAILED_CALCULATIONS_PDF",
  "BULK_PAYSLIPS_PDF",
  "EPF_CSV",
  "SOCSO_EIS_TXT",
  "PCB_TXT",
] as const

export type PayrollReportKind = (typeof payrollReportKinds)[number]

/**
 * Grouping shown as a section header in the modal. Three groups:
 *   - REPORTS — internal documents the admin keeps for management.
 *   - STATUTORY — files the admin uploads to government portals.
 *   - PAYSLIPS — bulk payslip PDF for distribution to employees.
 */
export type PayrollReportGroup = "REPORTS" | "STATUTORY" | "PAYSLIPS"

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
  extension: "pdf" | "csv" | "txt"
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
  DETAILED_CALCULATIONS_PDF: {
    kind: "DETAILED_CALCULATIONS_PDF",
    group: "REPORTS",
    title: "Detailed Calculations",
    description:
      "Per-employee working showing how each statutory line was computed (PCB, EPF, SOCSO, EIS, HRDF).",
    portal: null,
    extension: "pdf",
    mimeType: "application/pdf",
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
    title: "SOCSO + EIS Contribution TXT",
    description:
      "Combined SOCSO + EIS upload (278-char fixed-width per PERKESO spec v1.0).",
    portal: "PERKESO ASSIST Portal",
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
    title: "Bulk Payslips",
    description: "Every employee's payslip concatenated into one PDF.",
    portal: null,
    extension: "pdf",
    mimeType: "application/pdf",
  },
}

export const PAYROLL_REPORT_GROUP_LABELS: Record<PayrollReportGroup, string> = {
  REPORTS: "Reports",
  STATUTORY: "Statutory uploads",
  PAYSLIPS: "Payslips",
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
    case "DETAILED_CALCULATIONS_PDF":
      return `Detailed_Calculations_${monthName}_${yy}.${meta.extension}`
    case "BULK_PAYSLIPS_PDF":
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
    case "PCB_TXT":
      return `PCB_${mmyyyy}.${meta.extension}`
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
