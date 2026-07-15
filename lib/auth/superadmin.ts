/**
 * Superadmin — Fusioneta-side "support mode" gate.
 *
 * A designated set of email addresses (from the SUPERADMIN_EMAILS env var,
 * comma-separated) are treated as internal support users. They can log
 * in normally and use their own home org, PLUS switch into ANY other
 * organisation on the platform to act as admin for support / debugging.
 *
 * Their actions inside a target org are rewritten in that org's audit
 * log to actor = "System (Support)" so customer admins can't tell which
 * Fusioneta staff member accessed their data. A parallel row in
 * SuperadminAuditLog records the REAL actor + target org + action for
 * Fusioneta-side accountability (see `modules/audit/...`).
 *
 * Design notes:
 * - Detection is env-based, NOT a DB column. Rotating support staff is
 *   a config change with immediate effect (no cookie / cache flush
 *   needed) — remove the email from SUPERADMIN_EMAILS and the next
 *   request loses god-mode.
 * - Recomputed on every `getCurrentSession()` call from the cookie's
 *   email, not stored durably in the session cookie. This way a
 *   previously-issued cookie can't retain god-mode after the email is
 *   removed from the env whitelist.
 * - Safe to import from anywhere — this module doesn't reach into the
 *   DB or the session store; it's a pure env lookup.
 *
 * SAFE ON CLIENT — this file compares strings against process.env,
 * which is a build-time constant in server bundles and undefined in
 * the client bundle. Callers using it in a client context would just
 * see "no superadmins" (empty list), which is the safe default.
 */

/**
 * Parse the SUPERADMIN_EMAILS env var into a normalised set of lowercase
 * emails. Trims whitespace, drops empty entries. Cached per-process
 * since env values don't change at runtime.
 */
let cachedEmails: Set<string> | null = null

function loadSuperadminEmails(): Set<string> {
  if (cachedEmails) return cachedEmails
  const raw = process.env.SUPERADMIN_EMAILS ?? ""
  const set = new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  )
  cachedEmails = set
  return set
}

/**
 * True when the given email is in the SUPERADMIN_EMAILS whitelist.
 * Case-insensitive. Empty / whitespace input returns false safely.
 * Use this to decorate a session with the isSuperadmin flag.
 */
export function isSuperadminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return loadSuperadminEmails().has(email.trim().toLowerCase())
}

/**
 * Full list of superadmin emails (lowercase). Useful for admin
 * dashboards that want to show "current support access holders".
 * Returns an empty array when the env var isn't set.
 */
export function getSuperadminEmails(): string[] {
  return [...loadSuperadminEmails()]
}
