import "server-only"

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"

import { getAuthSecret } from "@/lib/auth/session"

/**
 * Short-lived SSO hand-off token for the Altomate Accounting → AltomateHR
 * flow (Option C: master-key + HR-signed JWT).
 *
 * HR both ISSUES and VERIFIES this token, signed with its own
 * `AUTH_SECRET` (the same key that signs session cookies) — so there is
 * NO shared secret with Accounting. Accounting obtains a token via the
 * master-key-protected `/api/v1/admin/sso-ticket` endpoint, then redirects
 * the browser to `/api/sso/altomate?token=...`.
 *
 * It's a minimal HS256 JWT: header.payload.signature, base64url. The
 * `typ` claim namespaces it so it can never be confused with anything
 * else signed by the same secret.
 */

const SSO_TYP = "altomate-sso"
const DEFAULT_TTL_SECONDS = 120

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url")
}

export type SsoTokenClaims = {
  email: string
  typ: typeof SSO_TYP
  iat: number
  exp: number
  jti: string
}

/** Mint a signed, short-lived SSO token for a (already-verified) email. */
export function signSsoToken(input: {
  email: string
  ttlSeconds?: number
}): { token: string; expiresIn: number } {
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = b64url(
    JSON.stringify({
      email: input.email.trim().toLowerCase(),
      typ: SSO_TYP,
      iat: now,
      exp: now + ttl,
      jti: randomUUID(),
    } satisfies SsoTokenClaims),
  )
  const signature = createHmac("sha256", getAuthSecret())
    .update(`${header}.${payload}`)
    .digest("base64url")
  return { token: `${header}.${payload}.${signature}`, expiresIn: ttl }
}

/**
 * Verify an SSO token. Returns the claims when the signature, algorithm,
 * `typ`, and expiry all check out; otherwise null. Replay (single-use via
 * `jti`) is enforced by the caller (the SSO route, using Redis).
 */
export function verifySsoToken(token: string): SsoTokenClaims | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, signatureB64] = parts

  const expected = createHmac("sha256", getAuthSecret())
    .update(`${headerB64}.${payloadB64}`)
    .digest()
  const provided = Buffer.from(signatureB64, "base64url")
  if (expected.length !== provided.length) return null
  if (!timingSafeEqual(expected, provided)) return null

  try {
    const header = JSON.parse(
      Buffer.from(headerB64, "base64url").toString("utf8"),
    ) as { alg?: string }
    if (header.alg !== "HS256") return null
  } catch {
    return null
  }

  let claims: SsoTokenClaims
  try {
    claims = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as SsoTokenClaims
  } catch {
    return null
  }

  if (claims.typ !== SSO_TYP) return null
  if (typeof claims.email !== "string" || claims.email.length === 0) return null
  if (typeof claims.exp !== "number") return null
  if (typeof claims.jti !== "string" || claims.jti.length === 0) return null

  const nowSec = Math.floor(Date.now() / 1000)
  if (claims.exp <= nowSec) return null

  return claims
}
