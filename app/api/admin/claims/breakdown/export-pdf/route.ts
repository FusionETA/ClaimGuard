import { NextResponse, type NextRequest } from "next/server"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { renderClaimsReportPdf } from "@/modules/claims/application/services/claims-report-pdf.service"

/**
 * GET /api/admin/claims/breakdown/export-pdf
 *
 * Same filter shape as `/api/admin/claims/breakdown/export` (the XLSX
 * exporter) — from/to/dateField/projects/teams/members/paymentType —
 * so both downloads always reflect the exact set the admin sees on
 * the reports page. Returns a landscape A4 PDF instead of XLSX.
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
  const paymentTypeRaw = url.searchParams.get("paymentType")
  const paymentType: "PERSONAL" | "COMPANY" | undefined =
    paymentTypeRaw === "PERSONAL" || paymentTypeRaw === "COMPANY"
      ? paymentTypeRaw
      : undefined

  const range = resolveRange(fromRaw, toRaw)

  const filterBits: string[] = []
  if (projectIds.length > 0) filterBits.push(`${projectIds.length} project(s)`)
  if (teamIds.length > 0) filterBits.push(`${teamIds.length} team(s)`)
  if (memberIds.length > 0) filterBits.push(`${memberIds.length} member(s)`)
  if (paymentType) filterBits.push(`payment: ${paymentType.toLowerCase()}`)
  if (dateField === "submitted") filterBits.push("date field: submitted")
  const filterSummary = filterBits.length > 0 ? filterBits.join(" · ") : null

  try {
    const buffer = await renderClaimsReportPdf({
      organizationId,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      resolvedFrom: range.resolvedFrom,
      resolvedTo: range.resolvedTo,
      dateField,
      projectIds,
      teamIds,
      memberIds,
      paymentType,
      filterSummary,
    })

    const filenameParts = ["claims", range.resolvedFrom, "to", range.resolvedTo]
    if (projectIds.length > 0) filenameParts.push(`p${projectIds.length}`)
    if (teamIds.length > 0) filenameParts.push(`t${teamIds.length}`)
    if (memberIds.length > 0) filenameParts.push(`m${memberIds.length}`)
    const filename = `${filenameParts.join("-")}.pdf`

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to render PDF."
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// Filter helpers (same shape as the XLSX route — kept inline for now,
// only the two claims routes call them; extract to a shared helper if
// a third caller appears).
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
