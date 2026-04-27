import "server-only"

import type {
  AdminProfile,
  ClaimRecord,
  PortalUser,
} from "@/modules/claims/domain/models"

// ---------------------------------------------------------------------------
// TTL — cached data is considered stale after this many milliseconds.
// ---------------------------------------------------------------------------

export const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/** Returns true if the store entry is older than CACHE_TTL_MS. */
export function isStoreExpired(cachedAt: number): boolean {
  return Date.now() - cachedAt > CACHE_TTL_MS
}

// ---------------------------------------------------------------------------
// Employee store — one entry per logged-in employee, keyed by email
// ---------------------------------------------------------------------------

export type EmployeeStore = {
  employee: PortalUser
  claims: ClaimRecord[]
  cachedAt: number
}

// ---------------------------------------------------------------------------
// Admin store — one entry per logged-in admin, keyed by email
// ---------------------------------------------------------------------------

export type AdminStore = {
  admin: AdminProfile
  allClaims: ClaimRecord[]
  cachedAt: number
  activeXeroConnectionId?: string
}

declare global {
  // eslint-disable-next-line no-var
  var __employeeStore: Map<string, EmployeeStore> | undefined
  // eslint-disable-next-line no-var
  var __adminStore: Map<string, AdminStore> | undefined
}

function employeeMap(): Map<string, EmployeeStore> {
  if (!globalThis.__employeeStore) {
    globalThis.__employeeStore = new Map()
  }
  return globalThis.__employeeStore
}

// --- Employee ---

export function getEmployeeStore(email: string): EmployeeStore | null {
  return employeeMap().get(email) ?? null
}

export function setEmployeeStore(email: string, data: EmployeeStore): void {
  employeeMap().set(email, data)
}

export function clearEmployeeStore(email: string): void {
  employeeMap().delete(email)
}

// --- Admin ---

function adminMap(): Map<string, AdminStore> {
  if (!globalThis.__adminStore) {
    globalThis.__adminStore = new Map()
  }
  return globalThis.__adminStore
}

export function getAdminStore(email: string): AdminStore | null {
  return adminMap().get(email) ?? null
}

export function setAdminStore(email: string, data: AdminStore): void {
  adminMap().set(email, data)
}

export function clearAdminStore(email?: string): void {
  if (!email) {
    adminMap().clear()
    return
  }

  adminMap().delete(email)
}
