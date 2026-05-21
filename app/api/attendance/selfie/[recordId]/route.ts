import { NextResponse } from "next/server"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import { getXeroFileContent } from "@/lib/xero"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
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
  _request: Request,
  context: { params: Promise<{ recordId: string }> },
) {
  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const { recordId } = await context.params

  const prisma = getPrismaClient()
  if (!prisma) {
    return NextResponse.json(
      { error: "Database is not configured." },
      { status: 500 },
    )
  }

  const record = await prisma.attendanceRecord.findUnique({
    where: { id: recordId },
    select: {
      employeeId: true,
      xeroSelfieFileId: true,
      employee: {
        select: {
          organizationId: true,
        },
      },
    },
  })
  if (!record || !record.xeroSelfieFileId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  // Authorization
  const isOwner = record.employeeId === session.userId
  const activeOrgId = resolveActiveOrgId(session)
  const isSameOrgAdmin =
    session.role === "ADMIN" &&
    !!record.employee.organizationId &&
    record.employee.organizationId === activeOrgId
  let isApproverInChain = false
  if (!isOwner && !isSameOrgAdmin && session.role === "SUPERVISOR") {
    const memberIds = await attendanceRepository.getTeamMemberIds(session.userId)
    isApproverInChain = memberIds.includes(record.employeeId)
  }
  if (!isOwner && !isSameOrgAdmin && !isApproverInChain) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // Resolve the org's single Xero connection.
  let connectionId: string | null = null
  if (record.employee.organizationId) {
    const conn = await prisma.xeroConnection.findFirst({
      where: { organizationId: record.employee.organizationId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    })
    connectionId = conn?.id ?? null
  }
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
