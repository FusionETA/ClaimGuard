/**
 * Domain types + metadata for the year-level annual tax forms surfaced
 * on the "Annual Tax Forms" page.
 *
 * Pure domain — consumed by both the page (client) and the renderers
 * (server).
 */

export const payrollAnnualReportKinds = [
  "FORM_EA_BULK_PDF",
  "FORM_E_CP8D_PDF",
  "CP8D_EMPLOYER_TXT",
  "CP8D_EMPLOYEE_TXT",
] as const

export type PayrollAnnualReportKind = (typeof payrollAnnualReportKinds)[number]

export type PayrollAnnualReportGroup = "FORMS" | "LHDN_TXT"

export type PayrollAnnualReportMeta = {
  kind: PayrollAnnualReportKind
  group: PayrollAnnualReportGroup
  title: string
  description: string
  portal: string | null
  extension: "pdf" | "txt"
  mimeType: string
}

export const PAYROLL_ANNUAL_REPORT_META: Record<
  PayrollAnnualReportKind,
  PayrollAnnualReportMeta
> = {
  FORM_EA_BULK_PDF: {
    kind: "FORM_EA_BULK_PDF",
    group: "FORMS",
    title: "Form EA (Bulk)",
    description:
      "One EA form per employee, concatenated. Distribute to employees by 28 Feb of the following year.",
    portal: null,
    extension: "pdf",
    mimeType: "application/pdf",
  },
  FORM_E_CP8D_PDF: {
    kind: "FORM_E_CP8D_PDF",
    group: "FORMS",
    title: "Form E + CP8D",
    description:
      "Employer's annual return cover page + CP8D table of per-employee particulars.",
    portal: null,
    extension: "pdf",
    mimeType: "application/pdf",
  },
  CP8D_EMPLOYER_TXT: {
    kind: "CP8D_EMPLOYER_TXT",
    group: "LHDN_TXT",
    title: "CP8D Employer Master TXT (M)",
    description:
      "Pipe-delimited employer master record — `M{employerNo}_{year}.TXT`.",
    portal: "LHDN e-CP8D upload",
    extension: "txt",
    mimeType: "text/plain",
  },
  CP8D_EMPLOYEE_TXT: {
    kind: "CP8D_EMPLOYEE_TXT",
    group: "LHDN_TXT",
    title: "CP8D Employee Particulars TXT (P)",
    description:
      "Pipe-delimited per-employee rows — `P{employerNo}_{year}.TXT`.",
    portal: "LHDN e-CP8D upload",
    extension: "txt",
    mimeType: "text/plain",
  },
}

export const PAYROLL_ANNUAL_REPORT_GROUP_LABELS: Record<
  PayrollAnnualReportGroup,
  string
> = {
  FORMS: "Forms",
  LHDN_TXT: "LHDN e-CP8D TXT upload",
}

/**
 * Build the user-facing filename. The CP8D TXT files include the
 * employer number in the filename (LHDN's convention) so admins can
 * tell which org/year a downloaded file belongs to.
 */
export function buildAnnualReportFileName(input: {
  kind: PayrollAnnualReportKind
  year: number
  employerNo: string
}): string {
  const meta = PAYROLL_ANNUAL_REPORT_META[input.kind]
  switch (input.kind) {
    case "FORM_EA_BULK_PDF":
      return `Form_EA_${input.year}_Bulk.${meta.extension}`
    case "FORM_E_CP8D_PDF":
      return `Form_E_CP8D_${input.year}.${meta.extension}`
    case "CP8D_EMPLOYER_TXT":
      return `M${input.employerNo || "EMPLOYER"}_${input.year}.${meta.extension.toUpperCase()}`
    case "CP8D_EMPLOYEE_TXT":
      return `P${input.employerNo || "EMPLOYER"}_${input.year}.${meta.extension.toUpperCase()}`
  }
}

export type PayrollAnnualReportRow = PayrollAnnualReportMeta & {
  generated: {
    fileName: string
    fileUrl: string
    sizeBytes: number
    generatedAt: string // ISO
  } | null
}
