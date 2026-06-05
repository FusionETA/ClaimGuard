import { describe } from "vitest"

/**
 * Authenticated HTTP client for the smoke suite.
 *
 * Every smoke test goes through here. It targets a DEPLOYED environment
 * (dev or prod) over the network — there is no Prisma and no server-only
 * import anywhere in `tests/smoke/`. The token is scoped to a dedicated
 * "Smoke Test Co" org, so creates/deletes can never touch real client
 * data.
 *
 * Env:
 *   - SMOKE_BASE_URL   e.g. https://dev-hr.altomate.io  (no trailing slash needed)
 *   - SMOKE_API_TOKEN  wp_live_smoke_* token for the Smoke Test Co org
 */

const RAW_BASE = process.env.SMOKE_BASE_URL?.trim() ?? ""
export const SMOKE_BASE_URL = RAW_BASE.replace(/\/+$/, "")
export const SMOKE_API_TOKEN = process.env.SMOKE_API_TOKEN?.trim() ?? ""

/** True only when both env vars are present. */
export const smokeEnvReady = Boolean(SMOKE_BASE_URL && SMOKE_API_TOKEN)

/**
 * Use this instead of `describe` at the top of every smoke file. When
 * SMOKE_BASE_URL / SMOKE_API_TOKEN are missing the whole suite is
 * skipped (with a one-time warning) rather than failing — so running
 * `npm run smoke` with no credentials is a harmless no-op locally.
 */
export const describeSmoke = smokeEnvReady ? describe : describe.skip

if (!smokeEnvReady) {
  console.warn(
    "[smoke] SMOKE_BASE_URL / SMOKE_API_TOKEN not set — smoke suites skipped.",
  )
}

export type ApiResponse<T = unknown> = {
  /** HTTP status code. */
  status: number
  /** status in the 2xx range. */
  ok: boolean
  /** Parsed JSON body (or null when the body was empty / non-JSON). */
  body: T
  /** Raw `Response` for header / edge inspection. */
  raw: Response
}

type Method = "GET" | "POST" | "PATCH" | "DELETE"

/**
 * Core request. Sends the bearer token, JSON-encodes the body, and
 * returns a parsed envelope. Never throws on non-2xx — assert on
 * `res.status` in the test so failures show the real status, not a
 * generic fetch error.
 */
export async function api<T = unknown>(
  method: Method,
  pathOrQuery: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  if (!smokeEnvReady) {
    throw new Error("[smoke] api() called without SMOKE_* env configured.")
  }
  const url = pathOrQuery.startsWith("http")
    ? pathOrQuery
    : `${SMOKE_BASE_URL}${pathOrQuery.startsWith("/") ? "" : "/"}${pathOrQuery}`

  const raw = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${SMOKE_API_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  let parsed: unknown = null
  const text = await raw.text()
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  return {
    status: raw.status,
    ok: raw.ok,
    body: parsed as T,
    raw,
  }
}

export const apiGet = <T = unknown>(path: string) => api<T>("GET", path)
export const apiPost = <T = unknown>(path: string, body?: unknown) =>
  api<T>("POST", path, body)
export const apiPatch = <T = unknown>(path: string, body?: unknown) =>
  api<T>("PATCH", path, body)
export const apiDelete = <T = unknown>(path: string) => api<T>("DELETE", path)

/**
 * Marker prefix stamped into the NAME of everything the suite creates.
 * The cleanup-verification test (and a human eyeballing the org) can
 * recognise smoke fixtures by this prefix. Keep it stable.
 */
export const SMOKE_PREFIX = "[SMOKE]"

/**
 * Build a collision-proof fixture name, e.g.
 *   tag("Employee") -> "[SMOKE] Employee 6f3a1c2b"
 * The random suffix keeps concurrent / re-run fixtures from clashing on
 * unique columns (email, employeeId, account code, …).
 */
export function tag(label: string): string {
  const suffix = crypto.randomUUID().slice(0, 8)
  return `${SMOKE_PREFIX} ${label} ${suffix}`
}

/** True when a resource name/title is one of ours (for the leftover sweep). */
export function isSmokeName(value: unknown): boolean {
  return typeof value === "string" && value.includes(SMOKE_PREFIX)
}
