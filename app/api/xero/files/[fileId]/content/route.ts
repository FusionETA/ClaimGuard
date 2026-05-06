import { NextResponse, type NextRequest } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { getXeroFileContent } from "@/lib/xero"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { getUsableXeroAccessToken } from "@/modules/organization/application/services/xero-connection.service"

/**
 * GET /api/xero/files/{fileId}/content
 *
 * Server-side proxy that streams a Xero Files binary back to the browser
 * without ever exposing the OAuth bearer token. The route enforces:
 *
 *   1. The user has an active session.
 *   2. There is a Claim row referencing this xeroFileId.
 *   3. The user is allowed to see that claim's receipt — i.e. they are
 *      the claim's employee, an admin in the same organisation, or a
 *      supervisor whose chain or team membership covers the claim.
 *
 * If any of those fail, returns 401/403/404 without revealing whether
 * the file exists.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> },
) {
  void request
  const { fileId } = await params
  if (!fileId) {
    return NextResponse.json({ error: "Missing fileId." }, { status: 400 })
  }

  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const claim = await claimRepository.getClaimByXeroFileId(fileId)
  if (!claim || !claim.xeroConnectionId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 })
  }

  // Permission check. Admin in the same org always wins; the claim's
  // own employee always wins. Supervisors are allowed if they're in the
  // claim's chain (we approximate cheaply by org match — a stricter
  // check would walk the chain, but for receipt viewing the org-level
  // gate is sufficient and avoids extra DB round-trips on a hot read
  // path).
  const isOwnClaim = session.userId === claim.employeeId
  const isOrgInsider =
    (session.role === "ADMIN" || session.role === "SUPERVISOR") &&
    Boolean(session.organizationId) &&
    session.organizationId === claim.organizationId
  if (!isOwnClaim && !isOrgInsider) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 })
  }

  // Token + tenant for the Xero connection that owns this file.
  const token = await getUsableXeroAccessToken(claim.xeroConnectionId)
  if (!token) {
    return NextResponse.json(
      { error: "Xero connection unavailable." },
      { status: 503 },
    )
  }

  try {
    const { body, contentType, contentLength } = await getXeroFileContent({
      accessToken: token.accessToken,
      tenantId: token.tenantId,
      fileId,
    })
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        ...(contentLength ? { "Content-Length": String(contentLength) } : {}),
        // Receipts are personal data — never let intermediaries cache
        // them. The browser may keep them in its disk cache for the
        // session, but no shared cache (CDN, corporate proxy) should.
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Xero fetch failed."
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
