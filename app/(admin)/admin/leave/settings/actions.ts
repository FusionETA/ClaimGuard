"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
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

async function requireAdminOrg(): Promise<string> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) redirect("/admin")
  return orgId
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
  const orgId = await requireAdminOrg()
  const input = parseTypeFormData(formData)
  const res = await createLeaveType(orgId, input)
  if (!res.ok) return { ok: false as const, error: res.error }
  revalidatePath("/admin/leave/settings")
  return { ok: true as const }
}

async function leaveTypeIsProtected(orgId: string, id: string): Promise<boolean> {
  const prisma = getPrismaClient()
  if (!prisma) return false
  const t = await prisma.leaveType.findFirst({
    where: { id, organizationId: orgId },
    select: { code: true },
  })
  return t ? isProtectedLeaveType(t.code) : false
}

export async function updateLeaveTypeAction(id: string, formData: FormData) {
  const orgId = await requireAdminOrg()
  if (await leaveTypeIsProtected(orgId, id)) {
    return { ok: false as const, error: "This leave type cannot be edited" }
  }
  const input = parseTypeFormData(formData)
  const res = await updateLeaveType(orgId, id, input)
  if (!res.ok) return { ok: false as const, error: res.error }
  revalidatePath("/admin/leave/settings")
  return { ok: true as const }
}

export async function archiveLeaveTypeAction(id: string) {
  const orgId = await requireAdminOrg()
  if (await leaveTypeIsProtected(orgId, id)) return
  await archiveLeaveType(orgId, id)
  revalidatePath("/admin/leave/settings")
}

export async function unarchiveLeaveTypeAction(id: string) {
  const orgId = await requireAdminOrg()
  if (await leaveTypeIsProtected(orgId, id)) return
  await unarchiveLeaveType(orgId, id)
  revalidatePath("/admin/leave/settings")
}

export async function setPolicyDefaultAction(input: {
  policyId: string
  leaveTypeId: string
  defaultDays: number
}) {
  const orgId = await requireAdminOrg()
  await leaveRepository.upsertPolicyDefault(
    orgId,
    input.policyId,
    input.leaveTypeId,
    Math.max(0, Number(input.defaultDays) || 0),
  )
  revalidatePath("/admin/leave/settings")
}

export async function clearPolicyDefaultAction(input: {
  policyId: string
  leaveTypeId: string
}) {
  const orgId = await requireAdminOrg()
  await leaveRepository.clearPolicyDefault(orgId, input.policyId, input.leaveTypeId)
  revalidatePath("/admin/leave/settings")
}

export async function setEmployeeEntitlementAction(input: {
  employeeId: string
  leaveTypeId: string
  year: number
  entitledDays: number
}) {
  await requireAdminOrg()
  // Scope-check employee belongs to admin's org.
  const prisma = getPrismaClient()
  if (!prisma) return
  const session = await getCurrentSession()
  const orgId = resolveActiveOrgId(session ?? undefined)
  const profile = await prisma.employeeProfile.findUnique({
    where: { id: input.employeeId },
    include: { user: { select: { organizationId: true } } },
  })
  if (!profile || profile.user.organizationId !== orgId) return

  await setEmployeeEntitlement(
    input.employeeId,
    input.leaveTypeId,
    input.year,
    Math.max(0, Number(input.entitledDays) || 0),
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
