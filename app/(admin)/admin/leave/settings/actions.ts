"use server"

import { revalidatePath } from "next/cache"
import { isAdminRole } from "@/lib/auth/types"
import type { AuthenticatedSession } from "@/lib/auth/types"
import { redirect } from "next/navigation"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import {
  archiveLeaveType,
  createLeaveType,
  unarchiveLeaveType,
  updateLeaveType,
  type LeaveTypeInput,
} from "@/modules/leave/application/services/leave-types.service"
import { isProtectedLeaveType } from "@/modules/leave/application/services/leave-defaults.service"
import {
  resetEmployeeEntitlementToDefault,
  setEmployeeEntitlement,
} from "@/modules/leave/application/services/leave-entitlements.service"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import type { LeaveAccrualMethod } from "@/modules/leave/domain/models"

async function requireAdminOrg(): Promise<{
  session: AuthenticatedSession
  orgId: string
}> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) redirect("/login")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) redirect("/admin")
  return { session, orgId }
}

function parseTypeFormData(formData: FormData): LeaveTypeInput {
  const paid = formData.get("paid") === "on" || formData.get("paid") === "true"
  const carryForward = formData.get("carryForward") === "on" || formData.get("carryForward") === "true"
  const accrualMethod = (String(formData.get("accrualMethod") ?? "LUMP_SUM") as LeaveAccrualMethod)
  const carryExpiryMonthRaw = formData.get("carryExpiryMonth")
  const maxRaw = formData.get("maxCarryForwardDays")
  return {
    code: String(formData.get("code") ?? "").trim(),
    name: String(formData.get("name") ?? "").trim(),
    paid,
    accrualMethod,
    defaultDays: paid ? Number(formData.get("defaultDays") ?? 0) : 0,
    carryForward,
    carryExpiryMonth: carryForward && carryExpiryMonthRaw ? Number(carryExpiryMonthRaw) : null,
    maxCarryForwardDays:
      maxRaw && String(maxRaw).trim() !== "" ? Number(maxRaw) : null,
  }
}

export async function createLeaveTypeAction(formData: FormData) {
  const { session, orgId } = await requireAdminOrg()
  const input = parseTypeFormData(formData)
  const res = await createLeaveType(orgId, input)
  if (!res.ok) return { ok: false as const, error: res.error }
  void writeAudit({
    organizationId: orgId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "leave.type.create",
    status: "SUCCESS",
    summary: `Created leave type ${input.code} "${input.name}" (${input.defaultDays}d default${input.paid ? "" : ", unpaid"})`,
    targetType: "leave-type",
    metadata: { code: input.code, name: input.name, paid: input.paid, defaultDays: input.defaultDays },
  })
  revalidatePath("/admin/leave/settings")
  return { ok: true as const }
}

async function leaveTypeIsProtected(orgId: string, id: string): Promise<boolean> {
  const code = await leaveRepository.getLeaveTypeCodeForOrg(orgId, id)
  return code ? isProtectedLeaveType(code) : false
}

export async function updateLeaveTypeAction(id: string, formData: FormData) {
  const { session, orgId } = await requireAdminOrg()
  if (await leaveTypeIsProtected(orgId, id)) {
    return { ok: false as const, error: "This leave type cannot be edited" }
  }
  const input = parseTypeFormData(formData)
  const res = await updateLeaveType(orgId, id, input)
  if (!res.ok) return { ok: false as const, error: res.error }
  void writeAudit({
    organizationId: orgId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "leave.type.update",
    status: "SUCCESS",
    summary: `Updated leave type "${input.name}"`,
    targetType: "leave-type",
    targetId: id,
    metadata: { code: input.code, name: input.name, defaultDays: input.defaultDays },
  })
  revalidatePath("/admin/leave/settings")
  return { ok: true as const }
}

export async function archiveLeaveTypeAction(id: string) {
  const { session, orgId } = await requireAdminOrg()
  if (await leaveTypeIsProtected(orgId, id)) return
  await archiveLeaveType(orgId, id)
  void writeAudit({
    organizationId: orgId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "leave.type.archive",
    status: "SUCCESS",
    summary: "Archived leave type",
    targetType: "leave-type",
    targetId: id,
  })
  revalidatePath("/admin/leave/settings")
}

export async function unarchiveLeaveTypeAction(id: string) {
  const { session, orgId } = await requireAdminOrg()
  if (await leaveTypeIsProtected(orgId, id)) return
  await unarchiveLeaveType(orgId, id)
  void writeAudit({
    organizationId: orgId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "leave.type.unarchive",
    status: "SUCCESS",
    summary: "Restored leave type",
    targetType: "leave-type",
    targetId: id,
  })
  revalidatePath("/admin/leave/settings")
}

export async function setPolicyDefaultAction(input: {
  policyId: string
  leaveTypeId: string
  /// Omit to leave the per-policy days override untouched.
  defaultDays?: number
  /// Omit to leave the per-policy method override untouched.
  /// Pass `null` to clear the override.
  /// Pass `"LUMP_SUM"` / `"PRO_RATED"` to set it.
  accrualMethod?: "LUMP_SUM" | "PRO_RATED" | null
}) {
  const { orgId } = await requireAdminOrg()
  const patch: {
    defaultDays?: number
    accrualMethod?: "LUMP_SUM" | "PRO_RATED" | null
  } = {}
  if (input.defaultDays !== undefined) {
    patch.defaultDays = Math.max(0, Number(input.defaultDays) || 0)
  }
  if (input.accrualMethod !== undefined) {
    patch.accrualMethod = input.accrualMethod
  }
  await leaveRepository.upsertPolicyDefault(
    orgId,
    input.policyId,
    input.leaveTypeId,
    patch,
  )
  revalidatePath("/admin/leave/settings")
}

export async function clearPolicyDefaultAction(input: {
  policyId: string
  leaveTypeId: string
}) {
  const { orgId } = await requireAdminOrg()
  await leaveRepository.clearPolicyDefault(orgId, input.policyId, input.leaveTypeId)
  revalidatePath("/admin/leave/settings")
}

export async function setEmployeeEntitlementAction(input: {
  employeeId: string
  leaveTypeId: string
  year: number
  /// Omit to leave the per-employee days override untouched.
  entitledDays?: number
  /// Omit to leave the per-employee method override untouched.
  /// Pass `null` to clear the override (resolver walks up to
  /// policy/type). Pass `"LUMP_SUM"` / `"PRO_RATED"` to set it.
  accrualMethod?: "LUMP_SUM" | "PRO_RATED" | null
}) {
  const { orgId: adminOrgId } = await requireAdminOrg()
  // Scope-check the target employee belongs to the admin's active org.
  const employeeOrgId = await leaveRepository.getEmployeeOrgId(input.employeeId)
  if (!employeeOrgId || employeeOrgId !== adminOrgId) return

  // The service requires an `entitledDays` value. When the caller is
  // only changing the method (omitting `entitledDays`), we re-use the
  // currently-stored value so we don't accidentally reset it.
  let days: number
  if (input.entitledDays !== undefined) {
    days = Math.max(0, Number(input.entitledDays) || 0)
  } else {
    const existing = await leaveRepository.getEntitlement(
      input.employeeId,
      input.leaveTypeId,
      input.year,
    )
    days = existing?.entitledDays ?? 0
  }

  await setEmployeeEntitlement(
    input.employeeId,
    input.leaveTypeId,
    input.year,
    days,
    input.accrualMethod,
  )
  revalidatePath("/admin/leave/settings")
}

export async function resetEmployeeEntitlementAction(input: {
  employeeId: string
  leaveTypeId: string
  year: number
}) {
  await requireAdminOrg()
  await resetEmployeeEntitlementToDefault(
    input.employeeId,
    input.leaveTypeId,
    input.year,
  )
  revalidatePath("/admin/leave/settings")
}
