"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import {
  createInitialAddHierarchyMemberFormState,
  createInitialHierarchyFormState,
  type AddHierarchyMemberFormState,
  type HierarchyFormState,
} from "@/app/(admin)/admin/hierarchy/form-state"
import { clearAdminStore, clearEmployeeStore } from "@/lib/app-store"
import { getCurrentSession } from "@/lib/auth/session"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

const hierarchySchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["EMPLOYEE", "SUPERVISOR"]),
  project: z.string().optional(),
  jobTitle: z.string().min(1, "Job title is required."),
  email: z.string().email(),
})

const createMemberSchema = z.object({
  name: z.string().min(2, "Employee name is required."),
  email: z.string().email("Enter a valid email address."),
  password: z.string().min(8, "Temporary password must be at least 8 characters."),
  employeeId: z.string().min(2, "Employee ID is required."),
  role: z.enum(["EMPLOYEE", "SUPERVISOR"]),
  project: z.string().optional(),
  jobTitle: z.string().min(1, "Job title is required."),
})

export async function updateHierarchyAction(
  _previousState: HierarchyFormState,
  formData: FormData
): Promise<HierarchyFormState> {
  const xeroConnectionId = String(formData.get("xeroConnectionId") ?? "").trim() || undefined
  const values = {
    role: String(formData.get("role") ?? "EMPLOYEE") as "EMPLOYEE" | "SUPERVISOR",
    organizationId: "",
    project: String(formData.get("project") ?? "").trim(),
    jobTitle: String(formData.get("jobTitle") ?? "").trim(),
    supervisorId: "",
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

  const organizationId = session.activeOrganizationId ?? session.organizationId

  if (!organizationId) {
    return {
      ...createInitialHierarchyFormState(values),
      status: "error",
      message: "Set up your organization in settings before managing hierarchy.",
    }
  }

  const parsed = hierarchySchema.safeParse({
    userId: String(formData.get("userId") ?? ""),
    role: values.role,
    project: values.project || undefined,
    jobTitle: values.jobTitle,
    email: String(formData.get("email") ?? ""),
  })

  if (!parsed.success) {
    return {
      ...createInitialHierarchyFormState(values),
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to save hierarchy changes.",
    }
  }

  await organizationRepository.updateOrganizationMember({
    userId: parsed.data.userId,
    role: parsed.data.role,
    organizationId,
    project: parsed.data.project || undefined,
    jobTitle: parsed.data.jobTitle,
    xeroConnectionId,
  })

  clearEmployeeStore(parsed.data.email)
  clearAdminStore(session.email)
  revalidatePath("/admin")
  revalidatePath("/admin/hierarchy")
  revalidatePath("/employee")
  revalidatePath("/employee/review")

  return {
    ...createInitialHierarchyFormState({
      role: parsed.data.role,
      organizationId,
      project: parsed.data.project ?? "",
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
  const values = {
    name: String(formData.get("name") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
    employeeId: String(formData.get("employeeId") ?? "").trim(),
    role: String(formData.get("role") ?? "EMPLOYEE") as "EMPLOYEE" | "SUPERVISOR",
    organizationId: "",
    project: String(formData.get("project") ?? "").trim(),
    jobTitle: String(formData.get("jobTitle") ?? "").trim(),
    supervisorId: "",
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

  const organizationId = session.activeOrganizationId ?? session.organizationId

  if (!organizationId) {
    return {
      ...createInitialAddHierarchyMemberFormState(values),
      status: "error",
      message: "Set up your organization in settings before adding employees.",
    }
  }

  const parsed = createMemberSchema.safeParse({
    ...values,
    project: values.project || undefined,
  })

  if (!parsed.success) {
    return {
      ...createInitialAddHierarchyMemberFormState(values),
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to create employee.",
    }
  }

  const approverIds = formData.getAll("approverIds").map(String).filter(Boolean)
  // First approver in the chain is the direct supervisor
  const supervisorId = approverIds[0] || undefined

  let createdUserId: string
  try {
    const created = await organizationRepository.createOrganizationMember({
      name: parsed.data.name,
      email: parsed.data.email,
      password: parsed.data.password,
      employeeId: parsed.data.employeeId,
      role: parsed.data.role,
      organizationId,
      project: parsed.data.project || undefined,
      jobTitle: parsed.data.jobTitle,
      supervisorId,
      xeroConnectionId,
    })
    createdUserId = created.id
  } catch (error) {
    return {
      ...createInitialAddHierarchyMemberFormState(values),
      status: "error",
      message:
        error instanceof Error ? error.message : "Unable to create employee right now.",
    }
  }

  if (approverIds.length > 0) {
    try {
      await organizationRepository.setApprovalChain({
        employeeId: createdUserId,
        organizationId,
        approverIds,
      })
    } catch {
      // Chain save failure is non-fatal — employee was created, chain can be set later
    }
  }

  clearAdminStore(session.email)
  revalidatePath("/admin")
  revalidatePath("/admin/hierarchy")

  return {
    ...createInitialAddHierarchyMemberFormState(),
    status: "success",
    message: "Employee added successfully.",
  }
}

export async function saveApprovalChainAction(
  employeeId: string,
  approverIds: string[]
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  const organizationId = session.activeOrganizationId ?? session.organizationId

  if (!organizationId) {
    return { ok: false, message: "Set up your organization in settings before managing hierarchy." }
  }

  try {
    await organizationRepository.setApprovalChain({
      employeeId,
      organizationId,
      approverIds,
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to save approval chain.",
    }
  }

  clearAdminStore(session.email)
  revalidatePath("/admin")
  revalidatePath("/admin/hierarchy")

  return { ok: true, message: "Approval chain saved." }
}
