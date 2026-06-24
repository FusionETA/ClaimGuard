import { NextResponse, type NextRequest } from "next/server"
import { isAdminRole } from "@/lib/auth/types"
import * as XLSX from "xlsx"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

/**
 * GET /api/admin/claims/breakdown/export
 *
 * Auth: admin only.
 *
 * Query params (all optional except auth):
 *   from     - yyyy-mm-dd, inclusive
 *   to       - yyyy-mm-dd, inclusive (the route adds one day internally)
 *   projects - comma-separated project ids
 *   teams    - comma-separated team ids
 *   members  - comma-separated user ids (employees)
 *
 * Returns one flat sheet — one row per claim — matching whatever the
 * admin sees on the on-screen reports page. The filename includes the
 * date range so accumulated downloads stay readable in the user's
 * downloads folder.
 *
 * If no filter is supplied, defaults to the CURRENT MONTH (same as
 * the page) to avoid accidentally dumping every claim ever filed.
 */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return NextResponse.json({ error: "No active organisation." }, { status: 400 })
  }

  const url = new URL(request.url)
  const fromRaw = url.searchParams.get("from")
  const toRaw = url.searchParams.get("to")
  const dateFieldRaw = url.searchParams.get("dateField")
  const dateField: "spent" | "submitted" =
    dateFieldRaw === "submitted" ? "submitted" : "spent"
  const projectIds = csv(url.searchParams.get("projects"))
  const teamIds = csv(url.searchParams.get("teams"))
  const memberIds = csv(url.searchParams.get("members"))

  // Same date logic the page uses: parse yyyy-mm-dd → UTC bounds; on
  // any parse failure fall back to the current month.
  const range = resolveRange(fromRaw, toRaw)

  // Pull ALL matching claims (not just the on-screen page). 10k upper
  // bound is generous for an org-month report; if a real workload
  // breaches it we'll add streaming-write or chunked pagination.
  const { rows: claims } = await claimRepository.listClaimsForReports({
    organizationId,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    dateField,
    projectIds: projectIds.length > 0 ? projectIds : undefined,
    teamIds: teamIds.length > 0 ? teamIds : undefined,
    memberIds: memberIds.length > 0 ? memberIds : undefined,
    skip: 0,
    take: 10000,
  })

  const sheetRows = claims.map((c) => ({
    "Claim #": c.claimNumber,
    "Title": c.title,
    "Employee": c.employee?.name ?? "",
    "Employee email": c.employee?.email ?? "",
    "Project": c.employee?.project ?? "",
    "Account code": c.chartOfAccount?.code ?? "",
    "Account name": c.chartOfAccount?.name ?? "",
    "Amount": c.amount,
    "Currency": c.currency,
    "Spent on": c.spentAt.slice(0, 10),
    "Submitted on": c.submittedAt.slice(0, 10),
    "Status": c.status,
    "Payroll": c.payrollRunAttachment ? "Included" : "Not included",
    "Payroll run": c.payrollRunAttachment
      ? `${monthName(c.payrollRunAttachment.periodMonth)} ${c.payrollRunAttachment.periodYear}`
      : "",
    "Xero sync": describeXeroSync(c),
    "Reviewed by": c.reviewerName ?? "",
    "Review notes": c.reviewNotes ?? "",
  }))

  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.json_to_sheet(sheetRows)
  XLSX.utils.book_append_sheet(workbook, sheet, "Claims")

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })

  const filenameParts = ["claims", range.resolvedFrom, "to", range.resolvedTo]
  if (projectIds.length > 0) filenameParts.push(`p${projectIds.length}`)
  if (teamIds.length > 0) filenameParts.push(`t${teamIds.length}`)
  if (memberIds.length > 0) filenameParts.push(`m${memberIds.length}`)
  const filename = `${filenameParts.join("-")}.xlsx`

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers (mirror the page's date logic so the export's "default month"
// matches what the page is showing when no `from`/`to` is set)
// ---------------------------------------------------------------------------

function csv(value: string | null): string[] {
  if (!value) return []
  return value.split(",").map((s) => s.trim()).filter(Boolean)
}

function parseYmd(value: string | null): Date | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return new Date(Date.UTC(y, mo - 1, d))
}

function formatYmd(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function monthName(month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "long" }).format(
    new Date(Date.UTC(2026, month - 1, 1)),
  )
}

function describeXeroSync(claim: {
  xeroSyncStatus: "NOT_SYNCED" | "SYNCED" | "ERROR"
  xeroBillId?: string
  xeroSpendMoneyId?: string
  payrollRunAttachment?: {
    xeroSyncStatus: "NOT_SYNCED" | "SYNCED" | "ERROR"
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

function resolveRange(
  fromRaw: string | null,
  toRaw: string | null,
): { dateFrom: Date; dateTo: Date; resolvedFrom: string; resolvedTo: string } {
  const f = parseYmd(fromRaw)
  const t = parseYmd(toRaw)
  if (f && t && t >= f) {
    const dateToExclusive = new Date(t.getTime() + 24 * 60 * 60 * 1000)
    return {
      dateFrom: f,
      dateTo: dateToExclusive,
      resolvedFrom: formatYmd(f),
      resolvedTo: formatYmd(t),
    }
  }
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const endExclusive = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  )
  const endInclusive = new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000)
  return {
    dateFrom: start,
    dateTo: endExclusive,
    resolvedFrom: formatYmd(start),
    resolvedTo: formatYmd(endInclusive),
  }
}
