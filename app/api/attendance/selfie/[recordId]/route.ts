import { NextResponse } from "next/server"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getXeroFileContent } from "@/lib/xero"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { getUsableXeroAccessToken } from "@/modules/organization/application/services/xero-connection.service"

export const dynamic = "force-dynamic"

/// GET /api/attendance/selfie/{attendanceRecordId}
///
/// Streams the clock-in selfie back as image/jpeg (or whatever Xero
/// returns). Auth: caller must be (a) the employee on the record,
/// (b) an admin in the same org, or (c) a supervisor whose approval
/// chain includes that employee. 404 when no selfie is attached so
/// callers can hide the thumbnail safely.
export async function GET(
  request: Request,
  context: { params: Promise<{ recordId: string }> },
) {
  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { recordId } = await context.params
  const phase =
    new URL(request.url).searchParams.get("phase") === "clock-out"
      ? "clock-out"
      : ("clock-in" as const)

  const record = await attendanceRepository.getSelfieAccessRecord(recordId, phase)
  if (!record) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  // Authorization
  const isOwner = record.employeeId === session.userId
  const activeOrgId = resolveActiveOrgId(session)
  const isSameOrgAdmin =
    isAdminRole(session.role) &&
    !!record.employeeOrgId &&
    record.employeeOrgId === activeOrgId
  let isApproverInChain = false
  if (!isOwner && !isSameOrgAdmin && session.role === "SUPERVISOR") {
    const memberIds = await attendanceRepository.getTeamMemberIds(session.userId)
    isApproverInChain = memberIds.includes(record.employeeId)
  }
  if (!isOwner && !isSameOrgAdmin && !isApproverInChain) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // Resolve the org's single Xero connection.
  const connectionId = record.employeeOrgId
    ? await organizationRepository.getActiveXeroConnectionId(record.employeeOrgId)
    : null
  if (!connectionId) {
    return NextResponse.json(
      { error: "No Xero connection available." },
      { status: 502 },
    )
  }

  try {
    const token = await getUsableXeroAccessToken(connectionId)
    if (!token) {
      return NextResponse.json(
        { error: "Xero token unavailable." },
        { status: 502 },
      )
    }
    const file = await getXeroFileContent({
      accessToken: token.accessToken,
      tenantId: token.tenantId,
      fileId: record.xeroSelfieFileId,
    })
    return new NextResponse(file.body, {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        "Content-Length": String(file.body.byteLength),
        // Selfies don't change once uploaded; cache aggressively in the
        // browser so re-rendering the approval list doesn't refetch.
        "Cache-Control": "private, max-age=300",
      },
    })
  } catch (err) {
    console.error("[selfie proxy] fetch failed", err)
    return NextResponse.json(
      { error: "Failed to load selfie." },
      { status: 502 },
    )
  }
}
