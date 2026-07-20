import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import {
  ClaimsReportDocument,
  type ClaimsReportRow,
} from "@/modules/claims/application/services/report-renderers/claims-report-pdf"

export type ClaimsReportFilters = {
  organizationId: string
  dateFrom: Date
  dateTo: Date // exclusive
  resolvedFrom: string // yyyy-mm-dd, inclusive
  resolvedTo: string   // yyyy-mm-dd, inclusive
  dateField: "spent" | "submitted"
  projectIds: string[]
  teamIds: string[]
  memberIds: string[]
  paymentType?: "PERSONAL" | "COMPANY"
  filterSummary: string | null
}

/// Renders the admin claims report as a PDF (A4 landscape, one row per
/// claim, totals in the footer). Mirrors the exact filter shape the
/// XLSX exporter uses so the two downloads are always in sync.
export async function renderClaimsReportPdf(
  filters: ClaimsReportFilters,
): Promise<Buffer> {
  const [org, { rows: claims }] = await Promise.all([
    organizationRepository.getOrganizationById(filters.organizationId),
    claimRepository.listClaimsForReports({
      organizationId: filters.organizationId,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      dateField: filters.dateField,
      projectIds:
        filters.projectIds.length > 0 ? filters.projectIds : undefined,
      teamIds: filters.teamIds.length > 0 ? filters.teamIds : undefined,
      memberIds:
        filters.memberIds.length > 0 ? filters.memberIds : undefined,
      paymentType: filters.paymentType,
      skip: 0,
      // Same 10k cap as the XLSX exporter. Real workloads don't come
      // close for an org-month report; if that changes we'll paginate.
      take: 10000,
    }),
  ])

  const orgName = org?.name ?? "Organization"

  const rows: ClaimsReportRow[] = claims.map((c) => ({
    claimNumber: c.claimNumber,
    title: c.title,
    employeeName: c.employee?.name ?? "",
    employeeEmail: c.employee?.email ?? "",
    project: c.employee?.project ?? "",
    accountCode: c.chartOfAccount?.code ?? "",
    accountName: c.chartOfAccount?.name ?? "",
    amount: c.amount,
    currency: c.currency,
    spentOn: c.spentAt.slice(0, 10),
    status: c.status,
    payrollLabel: c.payrollRunAttachment
      ? `${monthName(c.payrollRunAttachment.periodMonth)} ${c.payrollRunAttachment.periodYear}`
      : null,
    xeroSyncLabel: describeXeroSync(c),
  }))

  const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0)
  // Match the on-screen "total amount" currency: prefer the currency
  // seen on any claim, else the org default, else MYR.
  const currency = rows[0]?.currency ?? "MYR"

  return renderToBuffer(
    <ClaimsReportDocument
      organizationName={orgName}
      resolvedFrom={filters.resolvedFrom}
      resolvedTo={filters.resolvedTo}
      filterSummary={filters.filterSummary}
      rows={rows}
      totalCount={rows.length}
      totalAmount={totalAmount}
      currency={currency}
      generatedAt={new Date()}
    />,
  )
}

function monthName(month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(
    new Date(Date.UTC(2026, month - 1, 1)),
  )
}

function describeXeroSync(claim: {
  xeroSyncStatus: string
  xeroBillId?: string
  xeroSpendMoneyId?: string
  payrollRunAttachment?: {
    xeroSyncStatus: string
  }
}): string {
  if (claim.xeroSyncStatus === "SYNCED") {
    if (claim.xeroSpendMoneyId) return "Synced as Spend Money"
    if (claim.xeroBillId) return "Synced as Bill"
    return "Synced"
  }
  if (claim.payrollRunAttachment?.xeroSyncStatus === "SYNCED") {
    return "Synced via payroll"
  }
  if (
    claim.xeroSyncStatus === "ERROR" ||
    claim.payrollRunAttachment?.xeroSyncStatus === "ERROR"
  ) {
    return "Error"
  }
  if (claim.payrollRunAttachment) return "Pending payroll sync"
  return "Not synced"
}
