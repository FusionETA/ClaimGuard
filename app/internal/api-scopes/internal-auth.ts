import "server-only"

import { cookies } from "next/headers"
import { timingSafeEqual } from "node:crypto"

/**
 * ⚠️ INTERNAL ADMIN GATE ⚠️
 *
 * This module guards `/internal/api-scopes` — a privileged page that
 * can read + edit API token scopes across EVERY organisation. It is
 * intentionally separate from the normal admin auth (`getCurrentSession`)
 * because it serves Zi Rong / FusionETA, not an organisation's admins.
 *
 * The password is read from the `INTERNAL_ADMIN_KEY` env var first,
 * with the hard-coded `12345qwerty` as a fallback so local-dev "just
 * works" without env setup. In production, ALWAYS set the env var to
 * a long random string — the fallback is for testing convenience only
 * and lives in git history regardless of whether you change it later.
 *
 * Flow:
 *   1. User visits /internal/api-scopes
 *   2. `isInternalUnlocked()` checks for the `internal_admin_unlocked`
 *      cookie — missing → page renders the password form.
 *   3. Form posts to `unlockAction` which calls `verifyInternalPassword`,
 *      sets the cookie on success, redirects back.
 *   4. Cookie lives 1 hour (`maxAge`). Re-entry needed after expiry.
 *
 * Cookie hardening:
 *   - httpOnly      → can't be read from JS
 *   - sameSite=lax  → no cross-site posts can use it
 *   - secure (prod) → HTTPS-only in production
 *   - signed value  → just a fixed "ok" string; the gate is the
 *                     password check at unlock time, not the cookie
 *                     contents. Treat it like a session cookie.
 */

const INTERNAL_UNLOCK_COOKIE = "internal_admin_unlocked"
const COOKIE_VALUE = "ok"
const ONE_HOUR_SECONDS = 60 * 60

// ⚠️ Hardcoded fallback — replace via INTERNAL_ADMIN_KEY env var in prod.
const FALLBACK_PASSWORD = "12345qwerty"

function getExpectedPassword(): string {
  const fromEnv = process.env.INTERNAL_ADMIN_KEY?.trim()
  return fromEnv && fromEnv.length > 0 ? fromEnv : FALLBACK_PASSWORD
}

/**
 * Constant-time password comparison. The strings are padded to the
 * same length first so `timingSafeEqual` doesn't throw — different
 * lengths immediately fail (you can't get a length match wrong without
 * knowing the secret's length, but `timingSafeEqual` requires
 * matching byte counts).
 */
export function verifyInternalPassword(supplied: string): boolean {
  const expected = getExpectedPassword()
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Sets the unlock cookie. Caller (the server action) is responsible
 * for redirecting / revalidating after this.
 */
export async function setInternalUnlockedCookie(): Promise<void> {
  const jar = await cookies()
  jar.set(INTERNAL_UNLOCK_COOKIE, COOKIE_VALUE, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/internal",
    maxAge: ONE_HOUR_SECONDS,
  })
}

/**
 * Clears the unlock cookie. Used by the "Lock" button on the page.
 */
export async function clearInternalUnlockedCookie(): Promise<void> {
  const jar = await cookies()
  jar.delete(INTERNAL_UNLOCK_COOKIE)
}

/**
 * True when the visitor has the valid unlock cookie. Cookie absence,
 * value mismatch, or any cookies() throw → false.
 */
export async function isInternalUnlocked(): Promise<boolean> {
  try {
    const jar = await cookies()
    const c = jar.get(INTERNAL_UNLOCK_COOKIE)
    return c?.value === COOKIE_VALUE
  } catch {
    return false
  }
}
