/**
 * Curated scope catalogue. Add new scopes here as the API surface grows;
 * a token can hold any subset. The :read variant always covers GET on a
 * resource; :write covers POST / PATCH / DELETE.
 *
 * "approvals:write" is intentionally distinct from "claims:write" — an
 * external admin portal might want to create/edit claims (via :write)
 * but not drive the approval flow.
 */
export const API_SCOPE_CATALOG = [
  "employees:read",
  "employees:write",
  "teams:read",
  "teams:write",
  "projects:read",
  "projects:write",
  "chart-of-accounts:read",
  "chart-of-accounts:write",
  "claims:read",
  "claims:write",
  "attendance:read",
  "attendance:write",
  "leave:read",
  "leave:write",
  "settings:read",
  "settings:write",
  "policies:read",
  "policies:write",
  "approvals:write",
] as const

export type ApiScope = (typeof API_SCOPE_CATALOG)[number]

export function isKnownApiScope(scope: string): scope is ApiScope {
  return (API_SCOPE_CATALOG as readonly string[]).includes(scope)
}
