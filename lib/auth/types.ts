export const appRoles = ["EMPLOYEE", "SUPERVISOR", "ADMIN"] as const

export type AppRole = (typeof appRoles)[number]

export type SessionUser = {
  userId: string
  email: string
  name: string
  role: AppRole
  initials: string
  subtitle: string
}

export type AuthenticatedSession = SessionUser & {
  expiresAt: number
}

export function isEmployeePortalRole(role: AppRole) {
  return role === "EMPLOYEE" || role === "SUPERVISOR"
}
