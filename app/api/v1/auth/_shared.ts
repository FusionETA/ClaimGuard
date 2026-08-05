import "server-only"

import { NextResponse, type NextRequest } from "next/server"

import { authenticateApiRequest, writeAuditLog } from "@/lib/api-auth"
import {
  authenticateMasterRequest,
  writeMasterAuditLog,
} from "@/lib/master-api-auth"

/**
 * Auth context for the `/api/v1/auth/*` identity endpoints, which accept
 * EITHER credential:
 *
 *  - **master** (`wp_master_*`) — a platform partner key with no single
 *    org. Used by first-party companion apps (e.g. ABPay) to authenticate
 *    an owner across ALL the orgs they administer. The org gate becomes
 *    "the user administers ≥ 1 org". A master key deliberately cannot read
 *    tenant data, so using it here only grants identity/authentication —
 *    never payroll/employee reads.
 *
 *  - **org** (`wp_live_*`) — a single per-org token (original behaviour,
 *    kept for backward-compat). The gate stays "the user administers THIS
 *    token's org".
 */
export type AuthEndpointContext =
  | { mode: "master"; partnerName: string }
  | { mode: "org"; organizationId: string }

/**
 * Wrap an `/api/v1/auth/*` handler with dual-mode auth (master OR
 * per-org), standard headers, and audit logging — chosen by the bearer
 * token's prefix. A `wp_master_` token takes the master path; anything
 * else takes the per-org path (so existing per-org callers keep working).
 *
 * SECURITY: letting a master key reach `/auth/verify` makes it a password
 * *verification* gate across every admin/owner (vs one org for a per-org
 * token). It can only CONFIRM a supplied password, never dump one, and the
 * handler still enforces the ADMIN/OWNER role + ≥1-org checks. Pair with
 * network-level rate limiting on these routes.
 */
export function handleAuthEndpointRequest(
  handler: (
    request: NextRequest,
    context: AuthEndpointContext,
  ) => Promise<NextResponse>,
) {
  return async function wrapped(request: NextRequest): Promise<NextResponse> {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
    const header = request.headers.get("authorization") ?? ""
    const raw = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? ""

    // ── Master-key path ──────────────────────────────────────────────
    if (raw.startsWith("wp_master_")) {
      const auth = await authenticateMasterRequest(request)
      if (!auth.ok) return withHeaders(auth.response)

      let response: NextResponse
      let errorMessage: string | null = null
      try {
        response = await handler(request, {
          mode: "master",
          partnerName: auth.masterKey.partnerName,
        })
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error)
        console.error(
          `[api/v1/auth] ${request.method} ${request.nextUrl.pathname} failed:`,
          error,
        )
        response = jsonError(500, "Internal server error.")
      }

      void writeMasterAuditLog({
        masterKeyId: auth.masterKey.id,
        method: request.method,
        path: request.nextUrl.pathname,
        statusCode: response.status,
        ip,
        errorMessage,
      })
      return withHeaders(response)
    }

    // ── Per-org path (backward-compat) ───────────────────────────────
    const auth = await authenticateApiRequest(request, [])
    if (!auth.ok) return withHeaders(auth.response)

    let response: NextResponse
    let errorMessage: string | null = null
    try {
      response = await handler(request, {
        mode: "org",
        organizationId: auth.integration.organizationId,
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
      console.error(
        `[api/v1/auth] ${request.method} ${request.nextUrl.pathname} failed:`,
        error,
      )
      response = jsonError(500, "Internal server error.")
    }

    void writeAuditLog({
      integrationId: auth.integration.id,
      method: request.method,
      path: request.nextUrl.pathname,
      statusCode: response.status,
      ip,
      errorMessage,
    })
    return withHeaders(response)
  }
}

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

function withHeaders(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store")
  response.headers.set("X-API-Version", "v1")
  return response
}
