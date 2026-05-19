import "server-only"

import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import {
  buildAnnualReportFileName,
  PAYROLL_ANNUAL_REPORT_META,
  payrollAnnualReportKinds,
  type PayrollAnnualReportKind,
  type PayrollAnnualReportRow,
} from "@/modules/payroll/domain/annual-reports"
import { payrollAnnualReportRepository } from "@/modules/payroll/infrastructure/payroll-annual-report.repository"
import { payrollCompanyInfoRepository } from "@/modules/payroll/infrastructure/payroll-company-info.repository"
import { renderFormEaBulkPdf } from "@/modules/payroll/application/services/report-renderers/form-ea-bulk-pdf"
import { renderFormECp8dPdf } from "@/modules/payroll/application/services/report-renderers/form-e-cp8d-pdf"
import { renderCp8dEmployerTxt } from "@/modules/payroll/application/services/report-renderers/cp8d-employer-txt"
import { renderCp8dEmployeeTxt } from "@/modules/payroll/application/services/report-renderers/cp8d-employee-txt"

/**
 * Page-data + action service for the "Annual Tax Forms" page.
 *
 * - `getPayrollAnnualReportsModalData(year)` returns the cached rows
 *   joined with static meta, plus the list of years we have any
 *   SUBMITTED runs for (drives the year picker).
 * - `generatePayrollAnnualReport(year, kind)` renders/saves the
 *   requested file (or short-circuits on cache hit).
 *
 * Year is bound by SUBMITTED runs — admin can't pre-generate a year
 * that has no submitted payroll yet (avoids creating an empty Form E
 * by accident).
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
  /// Whether the org has at least one SUBMITTED run for the selected
  /// year. The modal disables every download button when false.
  canGenerate: boolean
  /// True when the LHDN E-number is configured. The CP8D TXT files
  /// can't be generated without it; the UI surfaces this so admin
  /// knows where to look.
  employerNoConfigured: boolean
} | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

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
  const selectedYear = input.year ?? fallbackYear

  const stored = await payrollAnnualReportRepository.listForYear({
    organizationId: orgId,
    year: selectedYear,
  })
  const storedByKind = new Map(stored.map((s) => [s.kind, s]))

  const rows: PayrollAnnualReportRow[] = payrollAnnualReportKinds.map(
    (kind) => {
      const meta = PAYROLL_ANNUAL_REPORT_META[kind]
      const cached = storedByKind.get(kind)
      return {
        ...meta,
        generated: cached
          ? {
              fileName: cached.fileName,
              fileUrl: cached.fileUrl,
              sizeBytes: cached.sizeBytes,
              generatedAt: cached.generatedAt.toISOString(),
            }
          : null,
      }
    },
  )

  const canGenerate = availableYears.includes(selectedYear)
  const employerNoConfigured = Boolean(
    companyInfo?.employerTin && companyInfo.employerTin.trim().length > 0,
  )

  return {
    organizationName: org?.name ?? "",
    availableYears,
    selectedYear,
    rows,
    canGenerate,
    employerNoConfigured,
  }
}

export async function generatePayrollAnnualReport(input: {
  year: number
  kind: PayrollAnnualReportKind
}): Promise<{
  fileName: string
  fileUrl: string
  mimeType: string
  sizeBytes: number
  alreadyCached: boolean
}> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  // Cache hit — short-circuit.
  const cached = await payrollAnnualReportRepository.getByYearAndKind({
    organizationId: orgId,
    year: input.year,
    kind: input.kind,
  })
  if (cached) {
    return {
      fileName: cached.fileName,
      fileUrl: cached.fileUrl,
      mimeType: cached.mimeType,
      sizeBytes: cached.sizeBytes,
      alreadyCached: true,
    }
  }

  // Render bytes via the matching renderer.
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

  const uploadDir = path.join(
    process.cwd(),
    "public",
    "uploads",
    "payroll-annual-reports",
    orgId,
    String(input.year),
  )
  await mkdir(uploadDir, { recursive: true })

  const onDiskName = `${input.kind.toLowerCase()}.${meta.extension}`
  const onDiskPath = path.join(uploadDir, onDiskName)
  await writeFile(onDiskPath, bytes)

  const fileUrl = `/uploads/payroll-annual-reports/${orgId}/${input.year}/${onDiskName}`
  const contentHash = createHash("sha256").update(bytes).digest("hex")

  await payrollAnnualReportRepository.upsert({
    organizationId: orgId,
    year: input.year,
    kind: input.kind,
    fileName,
    fileUrl,
    mimeType: meta.mimeType,
    sizeBytes: bytes.byteLength,
    contentHash,
  })

  return {
    fileName,
    fileUrl,
    mimeType: meta.mimeType,
    sizeBytes: bytes.byteLength,
    alreadyCached: false,
  }
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
