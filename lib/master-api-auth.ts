import "server-only"

import { createHash, randomBytes } from "node:crypto"

import { NextResponse, type NextRequest } from "next/server"

import { getPrismaClient } from "@/lib/prisma"

/**
 * Master API key flow.
 *
 * A `MasterApiKey` is the platform-level credential issued to an
 * integration partner (e.g. "Acme HR portal"). It is used ONLY to call
 * `/api/v1/admin/*` endpoints — most importantly `POST
 * /api/v1/admin/organizations` to provision a new Workpulse Organization
 * on behalf of one of the partner's customers.
 *
 * Per-org work (employees, claims, etc.) is NOT done with the master
 * key. The provisioning call returns an `ApiIntegration` (per-org)
 * token in the response, and the partner uses THAT token for everything
 * else. This separation ensures a leaked master key can only create new
 * tenants — it cannot read any existing tenant's data.
 *
 * Token format: `wp_master_<64 hex chars>` (32 random bytes). Hashed
 * with SHA-256 before storage; the raw secret is shown to the operator
 * once at creation time and never again.
 */

export function generateMasterApiKey(): {
  raw: string
  hash: string
  prefix: string
} {
  // 32 random bytes → 64 hex chars. Wider than the per-org token (24
  // bytes) because a master key is more sensitive — it provisions
  // tenants and cannot be revoked granularly per-org.
  const secret = randomBytes(32).toString("hex")
  const raw = `wp_master_${secret}`
  return { raw, hash: hashMasterApiKey(raw), prefix: raw.slice(0, 14) }
}

export function hashMasterApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex")
}

export type AuthenticatedMasterKey = {
  id: string
  partnerName: string
}

export type MasterApiAuthResult =
  | { ok: true; masterKey: AuthenticatedMasterKey }
  | { ok: false; response: NextResponse }

/**
 * Resolve the bearer token on an incoming `/api/v1/admin/*` request.
 * Mirrors the per-org `authenticateApiRequest` but looks the token up
 * in `MasterApiKey` instead.
 *
 * Distinguishes a master key from a per-org token by the `wp_master_`
 * prefix; rejects per-org tokens here so a leaked tenant token can
 * never accidentally provision new orgs.
 */
export async function authenticateMasterRequest(
  request: NextRequest,
): Promise<MasterApiAuthResult> {
  const header = request.headers.get("authorization") ?? ""
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    return {
      ok: false,
      response: jsonError(401, "Missing or malformed Authorization header. Use 'Bearer <token>'."),
    }
  }

  const raw = match[1]!.trim()
  if (!raw) {
    return { ok: false, response: jsonError(401, "Empty token.") }
  }

  // Reject per-org tokens early so the prefix mismatch is the clearer
  // error message. Master endpoints REQUIRE a master key.
  if (!raw.startsWith("wp_master_")) {
    return {
      ok: false,
      response: jsonError(401, "This endpoint requires a master API key (wp_master_*)."),
    }
  }

  const prisma = getPrismaClient()
  if (!prisma) {
    return { ok: false, response: jsonError(503, "Database is not configured.") }
  }

  const tokenHash = hashMasterApiKey(raw)
  const row = await prisma.masterApiKey.findUnique({
    where: { tokenHash },
  })

  if (!row || !row.active) {
    return { ok: false, response: jsonError(401, "Invalid or revoked master key.") }
  }

  // Best-effort lastUsedAt update.
  void prisma.masterApiKey
    .update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {})

  return {
    ok: true,
    masterKey: { id: row.id, partnerName: row.partnerName },
  }
}

export async function writeMasterAuditLog(args: {
  masterKeyId: string
  method: string
  path: string
  statusCode: number
  ip?: string | null
  errorMessage?: string | null
  createdOrganizationId?: string | null
}): Promise<void> {
  const prisma = getPrismaClient()
  if (!prisma) return

  try {
    await prisma.masterApiAuditLog.create({
      data: {
        masterKeyId: args.masterKeyId,
        method: args.method,
        path: args.path.slice(0, 500),
        statusCode: args.statusCode,
        ip: args.ip ? args.ip.slice(0, 64) : null,
        errorMessage: args.errorMessage ?? null,
        createdOrganizationId: args.createdOrganizationId ?? null,
      },
    })
  } catch (error) {
    console.error("[master-api-audit] failed to write audit log:", error)
  }
}

/**
 * Wrap a `/api/v1/admin/*` route handler so auth, audit, and standard
 * headers are applied centrally. The handler can opt into recording
 * which Organization was created by setting
 * `response.headers.set("X-Created-Organization-Id", id)` — the wrapper
 * extracts and persists this in the audit row, then strips the header
 * before returning to the client.
 *
 * Usage:
 *
 *   export const POST = handleMasterApiRequest(async (req, ctx) => {
 *     // ctx.masterKey.id, ctx.masterKey.partnerName
 *     return NextResponse.json({ ... })
 *   })
 */
export function handleMasterApiRequest(
  handler: (
    request: NextRequest,
    context: { masterKey: AuthenticatedMasterKey },
  ) => Promise<NextResponse>,
) {
  return async function wrappedHandler(request: NextRequest): Promise<NextResponse> {
    const auth = await authenticateMasterRequest(request)

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null

    if (!auth.ok) {
      return withMasterApiHeaders(auth.response)
    }

    let response: NextResponse
    let errorMessage: string | null = null
    let createdOrgId: string | null = null
    try {
      response = await handler(request, { masterKey: auth.masterKey })
      // Internal signal: handler can flag the new org id via response
      // header. We strip it before returning so it never leaks to the
      // wire.
      const flagged = response.headers.get("X-Created-Organization-Id")
      if (flagged) {
        createdOrgId = flagged
        response.headers.delete("X-Created-Organization-Id")
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
      console.error(
        `[api/v1/admin] ${request.method} ${request.nextUrl.pathname} failed:`,
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
      createdOrganizationId: createdOrgId,
    })

    return withMasterApiHeaders(response)
  }
}

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

function withMasterApiHeaders(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store")
  response.headers.set("X-API-Version", "v1")
  return response
}
