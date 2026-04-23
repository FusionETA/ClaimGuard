import "server-only"

import { setAdminStore, setEmployeeStore } from "@/lib/app-store"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

/**
 * Fetches the employee's profile and all their claims from the database,
 * then stores the result in the app store for instant page reads.
 */
export async function loadEmployeeData(email: string): Promise<void> {
  const [employee, claims] = await Promise.all([
    claimRepository.getEmployeeWithProfile(email),
    claimRepository.getClaimsByEmployee(email),
  ])

  if (!employee) throw new Error(`Employee not found: ${email}`)

  setEmployeeStore(email, { employee, claims })
}

/**
 * Fetches the admin profile and ALL claims from the database,
 * then stores the result in the app store for instant page reads.
 */
export async function loadAdminData(email: string): Promise<void> {
  const [admin, allClaims] = await Promise.all([
    claimRepository.getAdminProfile(email),
    claimRepository.getAllClaims(),
  ])

  if (!admin) throw new Error(`Admin not found: ${email}`)

  setAdminStore({ admin, allClaims })
}
