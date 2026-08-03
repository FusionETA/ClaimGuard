import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getOrSetCache } from "@/lib/cache"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { key } from "@/lib/redis"
import {
  buildAnnualReportFileName,
  PAYROLL_ANNUAL_REPORT_META,
  payrollAnnualReportKinds,
  type PayrollAnnualReportKind,
  type PayrollAnnualReportRow,
} from "@/modules/payroll/domain/annual-reports"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { payrollCompanyInfoRepository } from "@/modules/payroll/infrastructure/payroll-company-info.repository"
import { renderFormEaBulkPdf } from "@/modules/payroll/application/services/report-renderers/form-ea-bulk-pdf"
import { renderFormECp8dPdf } from "@/modules/payroll/application/services/report-renderers/form-e-cp8d-pdf"
import { renderCp8dEmployerTxt } from "@/modules/payroll/application/services/report-renderers/cp8d-employer-txt"
import { renderCp8dEmployeeTxt } from "@/modules/payroll/application/services/report-renderers/cp8d-employee-txt"

/**
 * Page-data + on-demand streaming service for the "Annual Tax Forms"
 * page.
 *
 * Storage model matches the per-run reports: NOTHING is written to disk
 * or cache-indexed. Every download re-renders the file from the live
 * SUBMITTED payroll runs and streams the bytes back. The year gate (all
 * Jan-Dec runs approved) is enforced on both the page (`canGenerate`)
 * and the read path.
 *
 * - `getPayrollAnnualReportsPageData(year)` returns the static per-kind
 *   meta rows joined with coverage info, plus the list of years we have
 *   any SUBMITTED runs for (drives the year picker).
 * - `readPayrollAnnualReportFile(year, kind)` renders one file on demand
 *   and returns its bytes for a route handler to stream.
 */

export async function getPayrollAnnualReportsPageData(input: {
  year: number | null
}): Promise<{
  organizationName: string
  /// Years with at least one SUBMITTED PayrollRun — drives the picker.
  /// Sorted desc (most recent first).
  availableYears: number[]
  /// Currently-selected year. Resolves to the most recent year that has
  /// any SUBMITTED run, or the current year when none exist yet.
  selectedYear: number
  rows: PayrollAnnualReportRow[]
  /// Whether the org has all 12 monthly payroll runs SUBMITTED for the
  /// selected year. The modal disables every download button when false.
  canGenerate: boolean
  submittedMonthCount: number
  missingMonths: number[]
  /// True when the LHDN E-number is configured. The CP8D TXT files
  /// can't be generated without it; the UI surfaces this so admin
  /// knows where to look.
  employerNoConfigured: boolean
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // 10-min TTL; busted by `bustPayrollCaches` on run submissions. Keyed
  // by the selected year so each year's modal caches independently.
  return getOrSetCache(
    key("org", orgId, "payroll", "page", "annual-reports", String(input.year ?? "default")),
    600,
    () => loadAnnualReportsPageData(orgId, input.year),
  )
}

async function loadAnnualReportsPageData(
  orgId: string,
  year: number | null,
): Promise<{
  organizationName: string
  availableYears: number[]
  selectedYear: number
  rows: PayrollAnnualReportRow[]
  canGenerate: boolean
  submittedMonthCount: number
  missingMonths: number[]
  employerNoConfigured: boolean
} | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  const [org, submittedRunsByYear, companyInfo] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    prisma.payrollRun.findMany({
      where: { organizationId: orgId, status: "SUBMITTED" },
      select: { periodYear: true },
      distinct: ["periodYear"],
      orderBy: { periodYear: "desc" },
    }),
    payrollCompanyInfoRepository.getByOrgId(orgId),
  ])

  const availableYears = submittedRunsByYear.map((r) => r.periodYear)
  const fallbackYear = availableYears[0] ?? new Date().getFullYear()
  const selectedYear = year ?? fallbackYear

  const coverage = await payrollRunRepository.getAnnualSubmissionCoverage({
    organizationId: orgId,
    year: selectedYear,
  })

  // Every download is rendered on demand, so there's no per-year
  // "generated" state to merge — every row is just the static meta.
  const rows: PayrollAnnualReportRow[] = payrollAnnualReportKinds.map(
    (kind) => ({
      ...PAYROLL_ANNUAL_REPORT_META[kind],
      generated: null,
    }),
  )

  const canGenerate = coverage.complete
  const employerNoConfigured = Boolean(
    companyInfo?.employerTin && companyInfo.employerTin.trim().length > 0,
  )

  return {
    organizationName: org?.name ?? "",
    availableYears,
    selectedYear,
    rows,
    canGenerate,
    submittedMonthCount: coverage.submittedMonths.length,
    missingMonths: coverage.missingMonths,
    employerNoConfigured,
  }
}

/**
 * Render one annual tax form on demand and return its bytes for a route
 * handler to stream. No disk, no repo, no cache read — produced fresh
 * from the live SUBMITTED runs every time.
 *
 * Gated on the complete Jan-Dec set of SUBMITTED runs (annual statutory
 * forms must not be generated from a partial year). Returns null when
 * the session/org doesn't match or the year isn't complete.
 */
export async function readPayrollAnnualReportFile(input: {
  year: number
  kind: PayrollAnnualReportKind
}): Promise<{
  bytes: Buffer
  fileName: string
  mimeType: string
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // Complete-year gate — the full Jan-Dec set of SUBMITTED runs must
  // exist before any annual statutory form is produced.
  const coverage = await payrollRunRepository.getAnnualSubmissionCoverage({
    organizationId: orgId,
    year: input.year,
  })
  if (!coverage.complete) return null

  const bytes = await renderAnnual({ year: input.year, kind: input.kind })

  // Look up employer number for the filename — CP8D files include it.
  const companyInfo = await payrollCompanyInfoRepository.getByOrgId(orgId)
  const employerNo = (companyInfo?.employerTin ?? "").replace(/[^0-9]/g, "")

  const meta = PAYROLL_ANNUAL_REPORT_META[input.kind]
  const fileName = buildAnnualReportFileName({
    kind: input.kind,
    year: input.year,
    employerNo,
  })

  return { bytes, fileName, mimeType: meta.mimeType }
}

async function renderAnnual(input: {
  year: number
  kind: PayrollAnnualReportKind
}): Promise<Buffer> {
  switch (input.kind) {
    case "FORM_EA_BULK_PDF":
      return renderFormEaBulkPdf({ year: input.year })
    case "FORM_E_CP8D_PDF":
      return renderFormECp8dPdf({ year: input.year })
    case "CP8D_EMPLOYER_TXT":
      return renderCp8dEmployerTxt({ year: input.year })
    case "CP8D_EMPLOYEE_TXT":
      return renderCp8dEmployeeTxt({ year: input.year })
  }
}
