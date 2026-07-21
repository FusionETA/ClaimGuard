/**
 * IPv4 whitelist matcher — supports single IPs (treated as `/32`) and
 * CIDR ranges (e.g. `203.106.51.0/24`) in a comma-separated string,
 * matching the shape admins type into `XeroProject.allowedIps`.
 *
 * Pure — no I/O. Used by:
 *   - `employee-attendance.service.ts` to gate clock-in on the
 *     employee's request IP.
 *   - The admin project-settings form for pre-save validation.
 *
 * IPv6 not supported yet (Malaysian office networks are still
 * overwhelmingly IPv4). If the parser sees an entry that isn't a
 * plausible IPv4 or IPv4 CIDR it silently drops that entry — safer
 * than throwing at request time and blocking every clock-in.
 */

/**
 * Extract the client IP from a Next.js request headers object.
 * Prefers `x-forwarded-for` (populated by any proxy / load balancer /
 * Vercel edge in front of the app), falling back to `x-real-ip`.
 *
 * Returns `null` when neither header is present — a signal to the
 * caller that IP detection isn't available (e.g. localhost dev with
 * no proxy). Fail-safe: callers should treat null as "check skipped"
 * rather than "check failed".
 */
export function extractClientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for")
  if (xff) {
    // x-forwarded-for is a comma-separated list "client, proxy1,
    // proxy2, …" — the LEFTMOST value is the original client. Strip
    // whitespace and take the first non-empty entry.
    const first = xff.split(",")[0]?.trim()
    if (first) return first
  }
  const real = headers.get("x-real-ip")?.trim()
  if (real) return real
  return null
}

/**
 * Parse the comma-separated allowlist string an admin typed into
 * `XeroProject.allowedIps` into structured CIDR entries. Silently
 * drops any entry that doesn't parse cleanly — bad rows don't block
 * good ones.
 */
export function parseAllowlist(raw: string | null | undefined): Array<{
  network: number
  prefix: number
  original: string
}> {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((entry) => {
      const parsed = parseCidrEntry(entry)
      return parsed ? { ...parsed, original: entry } : null
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
}

/**
 * Check whether an IP is covered by any entry in the allowlist.
 * Returns `false` when the allowlist is empty (caller decides
 * whether that means "check skipped" or "no one allowed" — see the
 * `requireIpWhitelist` docblock in schema.prisma; the current
 * product decision is "silently skipped when project has no IPs").
 */
export function ipMatchesAllowlist(
  ip: string,
  allowlist: ReadonlyArray<{ network: number; prefix: number }>,
): boolean {
  const ipAsInt = ipv4ToInt(ip)
  if (ipAsInt === null) return false
  for (const entry of allowlist) {
    if (matchCidr(ipAsInt, entry.network, entry.prefix)) return true
  }
  return false
}

/**
 * Convenience wrapper: parse the raw allowlist string AND check the
 * IP against it in one call. Useful for one-off checks; hot paths
 * that check many IPs against the same list should parse once and
 * reuse via `ipMatchesAllowlist`.
 */
export function ipMatchesRawAllowlist(
  ip: string,
  rawAllowlist: string | null | undefined,
): boolean {
  return ipMatchesAllowlist(ip, parseAllowlist(rawAllowlist))
}

/**
 * True when `entry` parses as either a bare IPv4 address or an IPv4 CIDR
 * range. Thin wrapper around the internal parser — use this from server
 * actions to reject a bad row before the admin's whole allowlist write
 * silently drops it at read time.
 */
export function isValidIpOrCidr(entry: string): boolean {
  return parseCidrEntry(entry.trim()) !== null
}

// ─── Internal ─────────────────────────────────────────────────────────

/**
 * Parse a single CIDR-notation string OR a bare IPv4 address (which
 * is treated as `/32`). Returns null for anything unparseable.
 */
function parseCidrEntry(
  entry: string,
): { network: number; prefix: number } | null {
  const [ipPart, prefixPart] = entry.split("/")
  const ip = ipv4ToInt(ipPart)
  if (ip === null) return null
  let prefix = 32
  if (prefixPart !== undefined) {
    const parsed = Number.parseInt(prefixPart, 10)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 32) return null
    prefix = parsed
  }
  // Mask the IP down to the network address so range comparisons are
  // canonical regardless of what the admin typed (e.g. accepting
  // `203.106.51.42/24` and treating it as `203.106.51.0/24`).
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const network = (ip & mask) >>> 0
  return { network, prefix }
}

/**
 * Convert an IPv4 dotted string into a 32-bit unsigned integer for
 * O(1) range comparisons. Returns null for non-IPv4 input.
 */
function ipv4ToInt(ip: string | undefined): number | null {
  if (!ip) return null
  const parts = ip.trim().split(".")
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    if (p.length === 0 || p.length > 3) return null
    const n = Number.parseInt(p, 10)
    if (!Number.isFinite(n) || n < 0 || n > 255) return null
    // Reject "01" / "001" style padded octets which parseInt happily
    // accepts but are ambiguous / non-standard.
    if (String(n) !== p) return null
    out = ((out << 8) | n) >>> 0
  }
  return out
}

function matchCidr(ipInt: number, network: number, prefix: number): boolean {
  if (prefix === 0) return true
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return ((ipInt & mask) >>> 0) === network
}
