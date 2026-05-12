"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import {
  employeePayoutMethods,
  otPayoutMethods,
} from "@/modules/organization/domain/models"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"

const baseSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(60, "Name too long."),
  description: z.string().trim().max(500).optional(),
  canAccessAttendance: z.boolean(),
  canAccessClaims: z.boolean(),
  canAccessLeave: z.boolean(),
  salaryType: z.enum(employeePayoutMethods),
  otMethod: z.enum(otPayoutMethods),
})

export type PolicyActionState = {
  status: "idle" | "success" | "error"
  message: string
}

const INITIAL: PolicyActionState = { status: "idle", message: "" }

async function requireOrgId(): Promise<string | { error: PolicyActionState }> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    return { error: { status: "error", message: "Session expired. Please log in again." } }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { error: { status: "error", message: "Set up your organization in settings first." } }
  }
  return organizationId
}

function parseBoolFlag(formData: FormData, name: string): boolean {
  const value = formData.get(name)
  if (value === null) return false
  const str = String(value).toLowerCase()
  return str === "on" || str === "true" || str === "1"
}

export async function createPolicyAction(
  _prev: PolicyActionState,
  formData: FormData,
): Promise<PolicyActionState> {
  const orgIdOrError = await requireOrgId()
  if (typeof orgIdOrError !== "string") return orgIdOrError.error

  const parsed = baseSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? "") || undefined,
    canAccessAttendance: parseBoolFlag(formData, "canAccessAttendance"),
    canAccessClaims: parseBoolFlag(formData, "canAccessClaims"),
    canAccessLeave: parseBoolFlag(formData, "canAccessLeave"),
    salaryType: String(formData.get("salaryType") ?? "HOURLY"),
    otMethod: String(formData.get("otMethod") ?? "CASH"),
  })

  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid policy." }
  }

  try {
    await policyRepository.create({
      organizationId: orgIdOrError,
      name: parsed.data.name,
      description: parsed.data.description,
      canAccessAttendance: parsed.data.canAccessAttendance,
      canAccessClaims: parsed.data.canAccessClaims,
      canAccessLeave: parsed.data.canAccessLeave,
      salaryType: parsed.data.salaryType,
      otMethod: parsed.data.otMethod,
    })
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to create policy.",
    }
  }

  await bustOrgConfigCaches({ organizationId: orgIdOrError })
  revalidatePath("/admin/settings")
  revalidatePath("/admin/hierarchy")
  return { status: "success", message: "Policy created." }
}

export async function updatePolicyAction(
  _prev: PolicyActionState,
  formData: FormData,
): Promise<PolicyActionState> {
  const orgIdOrError = await requireOrgId()
  if (typeof orgIdOrError !== "string") return orgIdOrError.error

  const id = String(formData.get("id") ?? "").trim()
  if (!id) return { status: "error", message: "Missing policy id." }

  const parsed = baseSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? "") || undefined,
    canAccessAttendance: parseBoolFlag(formData, "canAccessAttendance"),
    canAccessClaims: parseBoolFlag(formData, "canAccessClaims"),
    canAccessLeave: parseBoolFlag(formData, "canAccessLeave"),
    salaryType: String(formData.get("salaryType") ?? "HOURLY"),
    otMethod: String(formData.get("otMethod") ?? "CASH"),
  })

  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid policy." }
  }

  try {
    await policyRepository.update({
      id,
      organizationId: orgIdOrError,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      canAccessAttendance: parsed.data.canAccessAttendance,
      canAccessClaims: parsed.data.canAccessClaims,
      canAccessLeave: parsed.data.canAccessLeave,
      salaryType: parsed.data.salaryType,
      otMethod: parsed.data.otMethod,
    })
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to update policy.",
    }
  }

  await bustOrgConfigCaches({ organizationId: orgIdOrError })
  revalidatePath("/admin/settings")
  revalidatePath("/admin/hierarchy")
  revalidatePath("/employee")
  return { status: "success", message: "Policy updated." }
}

export async function setDefaultPolicyAction(
  _prev: PolicyActionState,
  formData: FormData,
): Promise<PolicyActionState> {
  const orgIdOrError = await requireOrgId()
  if (typeof orgIdOrError !== "string") return orgIdOrError.error

  const id = String(formData.get("id") ?? "").trim()
  if (!id) return { status: "error", message: "Missing policy id." }

  try {
    await policyRepository.setDefault(id, orgIdOrError)
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to set default.",
    }
  }

  revalidatePath("/admin/settings")
  return { status: "success", message: "Default policy updated." }
}

export async function archivePolicyAction(
  _prev: PolicyActionState,
  formData: FormData,
): Promise<PolicyActionState> {
  const orgIdOrError = await requireOrgId()
  if (typeof orgIdOrError !== "string") return orgIdOrError.error

  const id = String(formData.get("id") ?? "").trim()
  if (!id) return { status: "error", message: "Missing policy id." }

  try {
    await policyRepository.archive(id, orgIdOrError)
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to archive policy.",
    }
  }

  revalidatePath("/admin/settings")
  return { status: "success", message: "Policy archived." }
}

export const initialPolicyActionState = INITIAL
