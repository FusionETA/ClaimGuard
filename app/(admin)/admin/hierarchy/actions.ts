"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  createInitialAddHierarchyMemberFormState,
  createInitialHierarchyFormState,
  type AddHierarchyMemberFormState,
  type HierarchyFormState,
} from "@/app/(admin)/admin/hierarchy/form-state"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

const hierarchySchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["EMPLOYEE", "SUPERVISOR"]),
  projectIds: z.array(z.string()).default([]),
  jobTitle: z.string().min(1, "Job title is required."),
  policyId: z.string().min(1, "Employee policy is required."),
  email: z.string().email(),
})

const createMemberSchema = z.object({
  name: z.string().min(2, "Employee name is required."),
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Temporary password must be at least 8 characters."),
  employeeId: z.string().min(2, "Employee ID is required."),
  role: z.enum(["EMPLOYEE", "SUPERVISOR"]),
  projectIds: z.array(z.string()).default([]),
  jobTitle: z.string().min(1, "Job title is required."),
  policyId: z.string().min(1, "Employee policy is required."),
})

/// Pull the per-project routing config out of FormData. Each project section
/// emits hidden inputs `proj.{pid}.teamId`, `proj.{pid}.layer`, and one
/// `proj.{pid}.chainApprover.{N}` per layer above the employee. Empty values
/// are dropped. Only project ids in `selectedProjectIds` are kept.
function parseProjectAssignments(
  formData: FormData,
  selectedProjectIds: string[],
): Array<{
  projectId: string
  teamId: string
  layer: number
  chainApprovers: Array<{ layer: number; userId: string }>
}> {
  const out: Array<{
    projectId: string
    teamId: string
    layer: number
    chainApprovers: Array<{ layer: number; userId: string }>
  }> = []
  for (const projectId of selectedProjectIds) {
    const teamId = String(formData.get(`proj.${projectId}.teamId`) ?? "").trim()
    const layerRaw = Number(formData.get(`proj.${projectId}.layer`) ?? 1)
    if (!teamId) continue
    const chainApprovers: Array<{ layer: number; userId: string }> = []
    for (const [key, value] of formData.entries()) {
      const prefix = `proj.${projectId}.chainApprover.`
      if (!key.startsWith(prefix)) continue
      const layer = Number(key.slice(prefix.length))
      if (!Number.isInteger(layer) || layer < 1) continue
      const userId = String(value).trim()
      if (!userId) continue
      chainApprovers.push({ layer, userId })
    }
    out.push({
      projectId,
      teamId,
      layer:
        Number.isFinite(layerRaw) && Number.isInteger(layerRaw) && layerRaw >= 1
          ? layerRaw
          : 1,
      chainApprovers,
    })
  }
  return out
}

export async function updateHierarchyAction(
  _previousState: HierarchyFormState,
  formData: FormData
): Promise<HierarchyFormState> {
  const xeroConnectionId = String(formData.get("xeroConnectionId") ?? "").trim() || undefined
  const role = String(formData.get("role") ?? "EMPLOYEE") as "EMPLOYEE" | "SUPERVISOR"
  const values = {
    role,
    organizationId: "",
    jobTitle: String(formData.get("jobTitle") ?? "").trim(),
    xeroConnectionId: xeroConnectionId ?? "",
  }
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return {
      ...createInitialHierarchyFormState(values),
      status: "error",
      message: "Session expired. Please log in again.",
    }
  }

  const organizationId = resolveActiveOrgId(session)

  if (!organizationId) {
    return {
      ...createInitialHierarchyFormState(values),
      status: "error",
      message: "Set up your organization in settings before managing hierarchy.",
    }
  }

  const projectIds = formData.getAll("projectIds").map(String).filter(Boolean)
  const projectAssignments = parseProjectAssignments(formData, projectIds)

  const policyId = String(formData.get("policyId") ?? "").trim() || undefined
  const parsed = hierarchySchema.safeParse({
    userId: String(formData.get("userId") ?? ""),
    role: values.role,
    projectIds,
    jobTitle: values.jobTitle,
    policyId,
    email: String(formData.get("email") ?? ""),
  })

  if (!parsed.success) {
    return {
      ...createInitialHierarchyFormState(values),
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to save hierarchy changes.",
    }
  }

  try {
    await organizationRepository.updateOrganizationMember({
      userId: parsed.data.userId,
      role: parsed.data.role,
      organizationId,
      projectIds: parsed.data.projectIds,
      jobTitle: parsed.data.jobTitle,
      xeroConnectionId,
      policyId: parsed.data.policyId,
      projectAssignments,
    })
  } catch (error) {
    return {
      ...createInitialHierarchyFormState(values),
      status: "error",
      message:
        error instanceof Error ? error.message : "Unable to save hierarchy changes.",
    }
  }

  revalidatePath("/admin")
  revalidatePath("/admin/hierarchy")
  revalidatePath("/admin/company-structure")
  revalidatePath("/employee")
  revalidatePath("/employee/account")
  revalidatePath("/employee/review")

  // Bust admin page-data + per-user form-helper caches for the org so
  // the new/edited member shows up everywhere on next navigation.
  if (organizationId) {
    await bustOrgConfigCaches({ organizationId })
  }

  return {
    ...createInitialHierarchyFormState({
      role: parsed.data.role,
      organizationId,
      jobTitle: parsed.data.jobTitle,
      xeroConnectionId: xeroConnectionId ?? "",
    }),
    status: "success",
    message: "Hierarchy updated successfully.",
  }
}

export async function createHierarchyMemberAction(
  _previousState: AddHierarchyMemberFormState,
  formData: FormData
): Promise<AddHierarchyMemberFormState> {
  const xeroConnectionId = String(formData.get("xeroConnectionId") ?? "").trim() || undefined
  const role = String(formData.get("role") ?? "EMPLOYEE") as "EMPLOYEE" | "SUPERVISOR"
  const values = {
    name: String(formData.get("name") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
    employeeId: String(formData.get("employeeId") ?? "").trim(),
    role,
    organizationId: "",
    jobTitle: String(formData.get("jobTitle") ?? "").trim(),
    xeroConnectionId: xeroConnectionId ?? "",
  }
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return {
      ...createInitialAddHierarchyMemberFormState(values),
      status: "error",
      message: "Session expired. Please log in again.",
    }
  }

  const organizationId = resolveActiveOrgId(session)

  if (!organizationId) {
    return {
      ...createInitialAddHierarchyMemberFormState(values),
      status: "error",
      message: "Set up your organization in settings before adding employees.",
    }
  }

  const projectIds = formData.getAll("projectIds").map(String).filter(Boolean)
  const projectAssignments = parseProjectAssignments(formData, projectIds)

  const policyId = String(formData.get("policyId") ?? "").trim() || undefined
  const parsed = createMemberSchema.safeParse({
    ...values,
    projectIds,
    policyId,
  })

  if (!parsed.success) {
    return {
      ...createInitialAddHierarchyMemberFormState(values),
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to create employee.",
    }
  }

  try {
    await organizationRepository.createOrganizationMember({
      name: parsed.data.name,
      email: parsed.data.email,
      password: parsed.data.password,
      employeeId: parsed.data.employeeId,
      role: parsed.data.role,
      organizationId,
      projectIds: parsed.data.projectIds,
      jobTitle: parsed.data.jobTitle,
      xeroConnectionId,
      policyId: parsed.data.policyId,
      projectAssignments,
    })
  } catch (error) {
    return {
      ...createInitialAddHierarchyMemberFormState(values),
      status: "error",
      message:
        error instanceof Error ? error.message : "Unable to create employee right now.",
    }
  }

  revalidatePath("/admin")
  revalidatePath("/admin/hierarchy")
  revalidatePath("/admin/company-structure")

  if (organizationId) {
    await bustOrgConfigCaches({ organizationId })
  }

  return {
    ...createInitialAddHierarchyMemberFormState(),
    status: "success",
    message: "Employee added successfully.",
  }
}
