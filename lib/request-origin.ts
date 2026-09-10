// Behind nginx, Next.js 16's `request.url` reports the listener address
// (e.g. http://localhost:3000) instead of the public host. Building absolute
// redirects from it sends browsers to localhost. Use this helper as the base
// for `new URL(path, base)` whenever a route handler returns a redirect.

/// Anything with a header lookup — a `Headers`, or the `ReadonlyHeaders`
/// that `headers()` from `next/headers` returns inside a server action.
/// Typed structurally so this file stays free of server-only imports and
/// can live in `lib/`.
type HeaderLookup = { get(name: string): string | null }

/**
 * Public origin (`https://host`) implied by a set of request headers.
 * Prefers the proxy's `x-forwarded-*` pair, falling back to `host`.
 */
export function getOriginFromHeaders(headers: HeaderLookup): string {
  const host =
    headers.get("x-forwarded-host") ??
    headers.get("host") ??
    "localhost:3000"
  const proto = headers.get("x-forwarded-proto") ?? "http"
  return `${proto}://${host}`
}

export function getRequestOrigin(request: Request): string {
  return getOriginFromHeaders(request.headers)
}
