import "server-only"

import { redirect } from "next/navigation"

import { requirePortalSession } from "@/lib/auth/session"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"
import {
  DEFAULT_MODULE_ACCESS,
  moduleAccessForPolicy,
  type EmployeeModuleAccess,
} from "@/modules/policy/domain/models"

/// Resolve the effective module-access flags for the currently logged-in
/// employee. Used by route guards in the employee portal to redirect away
/// from screens hidden by the assigned policy.
export async function getEffectiveModuleAccess(): Promise<{
  userId: string
  access: EmployeeModuleAccess
}> {
  const session = await requirePortalSession("EMPLOYEE")
  const policy = await policyRepository.findForUserId(session.userId)
  return {
    userId: session.userId,
    access: policy ? moduleAccessForPolicy(policy) : DEFAULT_MODULE_ACCESS,
  }
}

/// Redirects to `/employee` if the named module is hidden by policy.
/// Safe to call from a Server Component at the top of a module page.
export async function requireModuleAccess(
  module: keyof EmployeeModuleAccess,
): Promise<void> {
  const { access } = await getEffectiveModuleAccess()
  if (!access[module]) {
    redirect("/employee")
  }
}
