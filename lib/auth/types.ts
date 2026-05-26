export const appRoles = ["EMPLOYEE", "SUPERVISOR", "ADMIN", "OWNER"] as const

export type AppRole = (typeof appRoles)[number]

export type SessionUser = {
  userId: string
  email: string
  name: string
  role: AppRole
  initials: string
  subtitle: string
  organizationId?: string        // employee's home org (unchanged)
  organizationName?: string
  activeOrganizationId?: string  // admin's currently selected company
  activeXeroConnectionId?: string
}

export type AuthenticatedSession = SessionUser & {
  expiresAt: number
}

export function isEmployeePortalRole(role: AppRole) {
  return role === "EMPLOYEE" || role === "SUPERVISOR"
}

/**
 * True for any role with admin-portal privileges. OWNER is a superset of
 * ADMIN — it sees and does everything an admin can — so every admin gate
 * in the app should use this helper instead of `role === "ADMIN"`,
 * otherwise owners get locked out of normal admin screens.
 */
export function isAdminRole(role: AppRole) {
  return role === "ADMIN" || role === "OWNER"
}

/**
 * True only for OWNER. Use this for the few owner-exclusive capabilities
 * (adding/removing admins). Regular admins must NOT pass this.
 */
export function isOwnerRole(role: AppRole) {
  return role === "OWNER"
}
