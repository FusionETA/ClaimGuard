import { NextResponse } from "next/server"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getXeroFileContent } from "@/lib/xero"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { getUsableXeroAccessToken } from "@/modules/organization/application/services/xero-connection.service"

export const dynamic = "force-dynamic"

/// GET /api/leave/files/{xeroFileId}/content
///
/// Server-side proxy that streams a leave-attachment binary from Xero
/// back to the browser without exposing the OAuth bearer token. Mirrors
/// the attendance-selfie and claim-receipt proxies.
///
/// Auth: caller must be one of
///   - the employee who submitted the leave application
///   - an admin in the same organisation
///   - a supervisor whose team membership covers the employee
///
/// Returns 404 (not 403) when the file isn't tied to a leave application
/// the caller can see, so the existence of unrelated files isn't leaked.
export async function GET(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { fileId } = await context.params
  if (!fileId) {
    return NextResponse.json({ error: "Missing fileId" }, { status: 400 })
  }

  const app = await leaveRepository.getApplicationByXeroFileId(fileId)
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  // Authorisation.
  const employeeUserId = app.employee.user.id
  const employeeOrgId = app.employee.user.organizationId
  const activeOrgId = resolveActiveOrgId(session)
  const isOwner = employeeUserId === session.userId
  const isSameOrgAdmin =
    session.role === "ADMIN" &&
    !!employeeOrgId &&
    employeeOrgId === activeOrgId
  let isSupervisor = false
  if (!isOwner && !isSameOrgAdmin && session.role === "SUPERVISOR") {
    const memberIds = await attendanceRepository.getTeamMemberIds(session.userId)
    isSupervisor = memberIds.includes(employeeUserId)
  }
  if (!isOwner && !isSameOrgAdmin && !isSupervisor) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // Resolve the org's single Xero connection.
  const connectionId = employeeOrgId
    ? await organizationRepository.getActiveXeroConnectionId(employeeOrgId)
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
      fileId,
    })
    return new NextResponse(file.body, {
      status: 200,
      headers: {
        "Content-Type": file.contentType,
        ...(file.contentLength
          ? { "Content-Length": String(file.contentLength) }
          : {}),
        // MC slips are personal data — never let intermediaries cache.
        "Cache-Control": "private, no-store",
      },
    })
  } catch (err) {
    console.error("[leave file proxy] fetch failed", err)
    return NextResponse.json(
      { error: "Failed to load attachment." },
      { status: 502 },
    )
  }
}
