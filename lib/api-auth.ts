import "server-only"

import { createHash, randomBytes } from "node:crypto"

import { NextResponse, type NextRequest } from "next/server"

import { getPrismaClient } from "@/lib/prisma"
import { isKnownApiScope, type ApiScope } from "@/lib/api-scopes"

/**
 * Generate a fresh API token. Format: `wp_live_<32 hex chars>`. The
 * prefix is shown plaintext in the admin UI so a token can be visually
 * identified later ("wp_live_********abcd"); the rest is the secret.
 *
 * Returns BOTH the raw token and its hash. The raw token is shown to
 * the user exactly once on creation; only the hash is persisted.
 */
export function generateApiToken(): {
  raw: string
  hash: string
  prefix: string
} {
  const secret = randomBytes(24).toString("hex")
  const raw = `wp_live_${secret}`
  return { raw, hash: hashApiToken(raw), prefix: raw.slice(0, 12) }
}

/**
 * Hash a raw token. SHA-256 is fine here because the token is already
 * high-entropy random bytes — no need for a slow KDF (bcrypt would just
 * burn CPU on every API call without adding meaningful protection).
 */
export function hashApiToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex")
}

export type AuthenticatedIntegration = {
  id: string
  name: string
  organizationId: string
  scopes: ApiScope[]
}

export type ApiAuthResult =
  | { ok: true; integration: AuthenticatedIntegration }
  | { ok: false; response: NextResponse }

/**
 * Resolve the bearer token on an incoming /api/v1 request. Returns
 * either an authenticated `integration` for the route handler to use,
 * or a `NextResponse` to send back directly (401/403/etc).
 *
 * Always pair this with `writeAuditLog` after the route runs so the
 * call is traceable.
 *
 * Side effects:
 *  - Updates `ApiIntegration.lastUsedAt` (best-effort; failure does not
 *    block the request).
 */
export async function authenticateApiRequest(
  request: NextRequest,
  requiredScopes: ApiScope[],
): Promise<ApiAuthResult> {
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

  const prisma = getPrismaClient()
  if (!prisma) {
    return { ok: false, response: jsonError(503, "Database is not configured.") }
  }

  const tokenHash = hashApiToken(raw)
  const row = await prisma.apiIntegration.findUnique({
    where: { tokenHash },
  })

  if (!row || !row.active) {
    // 401 deliberately: don't tell the caller whether the token exists
    // but is revoked vs. doesn't exist at all.
    return { ok: false, response: jsonError(401, "Invalid or revoked token.") }
  }

  const tokenScopes = parseScopes(row.scopes)
  const missing = requiredScopes.filter((s) => !tokenScopes.includes(s))
  if (missing.length > 0) {
    return {
      ok: false,
      response: jsonError(
        403,
        `Token is missing required scope${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
      ),
    }
  }

  // Best-effort lastUsedAt update — fire-and-forget so a write failure
  // doesn't block legitimate API traffic.
  void prisma.apiIntegration
    .update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {
      // Swallow — last-used is a UX nicety, not load-bearing.
    })

  return {
    ok: true,
    integration: {
      id: row.id,
      name: row.name,
      organizationId: row.organizationId,
      scopes: tokenScopes,
    },
  }
}

/**
 * Write an audit row for a request that was authenticated via
 * `authenticateApiRequest`. Call this after the handler resolves —
 * pass the response status + optional error message.
 *
 * Best-effort: any DB failure here is logged to the server console but
 * does NOT propagate (we already responded to the client).
 */
export async function writeAuditLog(args: {
  integrationId: string
  method: string
  path: string
  statusCode: number
  ip?: string | null
  errorMessage?: string | null
}): Promise<void> {
  const prisma = getPrismaClient()
  if (!prisma) return

  try {
    await prisma.apiAuditLog.create({
      data: {
        integrationId: args.integrationId,
        method: args.method,
        path: args.path.slice(0, 500),
        statusCode: args.statusCode,
        ip: args.ip ? args.ip.slice(0, 64) : null,
        errorMessage: args.errorMessage ?? null,
      },
    })
  } catch (error) {
    console.error("[api-audit] failed to write audit log:", error)
  }
}

/**
 * Shape of the route context Next.js 15+ App Router passes to dynamic
 * route handlers as the second arg. `params` is async — Next started
 * making this a Promise so request streaming can begin before the
 * router resolves the segment values.
 */
type NextRouteContext<P extends Record<string, string | string[]> = Record<string, string | string[]>> = {
  params: Promise<P>
}

/**
 * Wrap a route handler so the boilerplate (auth, audit, JSON
 * serialisation, no-store cache header) lives in one place. Usage:
 *
 *   export const GET = handleApiRequest(["employees:read"], async (req, ctx) => {
 *     // ctx.integration.organizationId is the resolved org
 *     // ctx.params is whatever the dynamic route segment(s) resolved to
 *     return NextResponse.json({ ... })
 *   })
 *
 * `ctx.params` is the resolved Next.js `params` object — already awaited
 * so handlers don't have to. Empty object on non-dynamic routes (the
 * top-level `/api/v1/employees` POST has no segments, so `ctx.params`
 * is `{}`). Dynamic routes like `/api/v1/employees/[id]` get
 * `ctx.params.id`.
 */
export function handleApiRequest<
  P extends Record<string, string | string[]> = Record<string, string | string[]>,
>(
  requiredScopes: ApiScope[],
  handler: (
    request: NextRequest,
    context: { integration: AuthenticatedIntegration; params: P },
  ) => Promise<NextResponse>,
) {
  return async function wrappedHandler(
    request: NextRequest,
    routeContext?: NextRouteContext<P>,
  ): Promise<NextResponse> {
    const auth = await authenticateApiRequest(request, requiredScopes)

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null

    if (!auth.ok) {
      // Unauthenticated calls don't get audit-logged — we wouldn't know
      // which integration to attribute them to. The auth response
      // itself carries the failure reason.
      return withApiHeaders(auth.response)
    }

    // Resolve dynamic-route params once. Static routes pass no second
    // arg; dynamic ones pass `{ params: Promise<...> }`.
    const params = (routeContext?.params
      ? await routeContext.params
      : ({} as P))

    let response: NextResponse
    let errorMessage: string | null = null
    try {
      response = await handler(request, {
        integration: auth.integration,
        params,
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
      console.error(
        `[api/v1] ${request.method} ${request.nextUrl.pathname} failed:`,
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

    return withApiHeaders(response)
  }
}

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

/**
 * Apply standard headers to every /api/v1 response: no caching, JSON
 * content-type (already set by NextResponse.json but keeps the
 * intent explicit), and an X-API-Version header so future v2 callers
 * don't trip on stale responses.
 */
function withApiHeaders(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store")
  response.headers.set("X-API-Version", "v1")
  return response
}

/** Defensive parse of the JSON-stored scopes column. */
function parseScopes(raw: unknown): ApiScope[] {
  if (!Array.isArray(raw)) return []
  const out: ApiScope[] = []
  for (const v of raw) {
    if (typeof v === "string" && isKnownApiScope(v) && !out.includes(v)) {
      out.push(v)
    }
  }
  return out
}
