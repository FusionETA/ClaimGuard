import { NextResponse, type NextRequest } from "next/server"
import * as XLSX from "xlsx"

import { getCurrentSession } from "@/lib/auth/session"
import {
  getMemberClaimsBreakdown,
  getMembersBreakdown,
  getProjectsBreakdown,
  getTeamsBreakdown,
  resolveMonthBounds,
} from "@/modules/claims/application/services/claims-breakdown.service"

/**
 * GET /api/admin/claims/breakdown/export
 *
 * Auth: admin only.
 *
 * Query params:
 *   level   - "projects" | "teams" | "members" | "claims"   (required)
 *   month   - "yyyy-mm" (defaults to current month)
 *   project - project id (required for teams / members / claims)
 *   team    - team id    (required for members)
 *   member  - employee id (required for claims)
 *
 * Builds an .xlsx with a single sheet appropriate to the level and
 * returns it as a binary download. Filename describes the scope so
 * downloads accumulate readably in the user's downloads folder, e.g.
 *   "claims-by-project-2026-05.xlsx"
 *   "claims-team-2026-05.xlsx"
 *   "claims-member-2026-05.xlsx"
 *
 * The query intentionally re-runs the same service functions the page
 * uses — single source of truth for what each level "means", and any
 * future filter/scoping changes flow through automatically.
 */
export async function GET(request: NextRequest) {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const url = new URL(request.url)
  const level = url.searchParams.get("level") ?? "projects"
  const monthKey = url.searchParams.get("month") ?? undefined
  const projectId = url.searchParams.get("project") ?? undefined
  const teamId = url.searchParams.get("team") ?? undefined
  const memberId = url.searchParams.get("member") ?? undefined

  // Sheet builder per level. Each branch returns:
  //   - rows: array of plain objects (one per spreadsheet row)
  //   - sheetName: tab label inside the workbook
  //   - filenamePart: middle segment of the download filename
  let rows: Record<string, unknown>[] = []
  let sheetName = "Claims breakdown"
  let filenamePart = "by-project"
  let resolvedMonthKey = monthKey

  if (level === "projects") {
    const data = await getProjectsBreakdown(monthKey)
    if (!data) {
      return NextResponse.json({ error: "No data." }, { status: 404 })
    }
    resolvedMonthKey = data.monthKey
    rows = data.projects.map((p) => ({
      Project: p.projectName,
      "Total amount": p.totalAmount,
      Claims: p.count,
      Pending: p.statusMix.PENDING ?? 0,
      Submitted: p.statusMix.SUBMITTED ?? 0,
      Approved: p.statusMix.APPROVED ?? 0,
      Paid: p.statusMix.PAID ?? 0,
      Rejected: p.statusMix.REJECTED ?? 0,
    }))
    sheetName = "Projects"
    filenamePart = "by-project"
  } else if (level === "teams") {
    if (!projectId) {
      return NextResponse.json(
        { error: "project parameter is required for teams export." },
        { status: 400 },
      )
    }
    const data = await getTeamsBreakdown({ projectId, monthKey })
    if (!data) {
      return NextResponse.json({ error: "No data." }, { status: 404 })
    }
    resolvedMonthKey = data.monthKey
    rows = data.teams.map((t) => ({
      Team: t.teamName,
      "Total amount": t.totalAmount,
      Claims: t.count,
      Pending: t.statusMix.PENDING ?? 0,
      Submitted: t.statusMix.SUBMITTED ?? 0,
      Approved: t.statusMix.APPROVED ?? 0,
      Paid: t.statusMix.PAID ?? 0,
      Rejected: t.statusMix.REJECTED ?? 0,
    }))
    sheetName = "Teams"
    filenamePart = "teams"
  } else if (level === "members") {
    if (!projectId || !teamId) {
      return NextResponse.json(
        { error: "project and team parameters are required for members export." },
        { status: 400 },
      )
    }
    const data = await getMembersBreakdown({ projectId, teamId, monthKey })
    if (!data) {
      return NextResponse.json({ error: "No data." }, { status: 404 })
    }
    resolvedMonthKey = data.monthKey
    rows = data.members.map((m) => ({
      Member: m.employeeName,
      Email: m.employeeEmail,
      "Total amount": m.totalAmount,
      Claims: m.count,
      Pending: m.statusMix.PENDING ?? 0,
      Submitted: m.statusMix.SUBMITTED ?? 0,
      Approved: m.statusMix.APPROVED ?? 0,
      Paid: m.statusMix.PAID ?? 0,
      Rejected: m.statusMix.REJECTED ?? 0,
    }))
    sheetName = "Members"
    filenamePart = "members"
  } else if (level === "claims") {
    if (!projectId || !memberId) {
      return NextResponse.json(
        {
          error:
            "project and member parameters are required for claims export.",
        },
        { status: 400 },
      )
    }
    const data = await getMemberClaimsBreakdown({
      projectId,
      employeeId: memberId,
      monthKey,
    })
    if (!data) {
      return NextResponse.json({ error: "No data." }, { status: 404 })
    }
    resolvedMonthKey = data.monthKey
    rows = data.claims.map((c) => ({
      "Claim #": c.claimNumber,
      Title: c.title,
      Date: new Date(c.spentAt).toISOString().slice(0, 10),
      "Account code": c.chartOfAccount?.code ?? "",
      "Account name": c.chartOfAccount?.name ?? "",
      Amount: c.amount,
      Currency: c.currency,
      Status: c.status,
      "Payment type": c.paymentType,
      "Submitted at": new Date(c.submittedAt).toISOString().slice(0, 10),
      Description: c.description,
    }))
    sheetName = "Claims"
    filenamePart = "member-claims"
  } else {
    return NextResponse.json({ error: "Invalid level." }, { status: 400 })
  }

  // Resolve a final month key so the filename always shows the period
  // even if the caller didn't pass one (current month default).
  const { monthKey: finalMonthKey } = resolveMonthBounds(resolvedMonthKey)

  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.json_to_sheet(rows)
  // Pre-size columns so the auditor doesn't have to drag-resize on every
  // open. Width is "characters" — heuristic from longest value per column.
  sheet["!cols"] = computeColumnWidths(rows)
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName.slice(0, 31)) // 31 char sheet-name limit

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer
  const filename = `claims-${filenamePart}-${finalMonthKey}.xlsx`

  // Slice into a fresh ArrayBuffer (not the underlying SlowBuffer pool)
  // to give NextResponse a clean BodyInit. Node's `Buffer` is a Uint8Array
  // backed by a shared pool — passing it through TS lib.dom typings
  // requires this conversion.
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer

  return new NextResponse(arrayBuffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Personal data → never let intermediaries cache it. Same posture
      // as the receipt-content proxy.
      "Cache-Control": "private, no-store",
    },
  })
}

/** Heuristic column-width computation. Iterates rows and finds the
 *  longest stringified value per column, then adds a bit of padding. */
function computeColumnWidths(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return []
  const headers = Object.keys(rows[0]!)
  return headers.map((header) => {
    let maxLen = header.length
    for (const row of rows) {
      const value = row[header]
      const len =
        typeof value === "number"
          ? value.toFixed(2).length
          : String(value ?? "").length
      if (len > maxLen) maxLen = len
    }
    return { wch: Math.min(maxLen + 2, 60) }
  })
}
