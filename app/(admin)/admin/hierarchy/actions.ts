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
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import {
  employeePayoutMethods,
  resolveEmployeePayoutMethod,
} from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

const hierarchySchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["EMPLOYEE", "SUPERVISOR"]),
  projectIds: z.array(z.string()).default([]),
  jobTitle: z.string().min(1, "Job title is required."),
  payoutMethod: z.enum(employeePayoutMethods),
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
  payoutMethod: z.enum(employeePayoutMethods),
})

export async function updateHierarchyAction(
  _previousState: HierarchyFormState,
  formData: FormData
): Promise<HierarchyFormState> {
  const xeroConnectionId = String(formData.get("xeroConnectionId") ?? "").trim() || undefined
  const role = String(formData.get("role") ?? "EMPLOYEE") as "EMPLOYEE" | "SUPERVISOR"
  const values = {
    role,
    organizationId: "",
    project: String(formData.get("project") ?? "").trim(),
    jobTitle: String(formData.get("jobTitle") ?? "").trim(),
    payoutMethod: resolveEmployeePayoutMethod(
      role,
      String(formData.get("payoutMethod") ?? "").trim()
    ),
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

  const organizationId = resolveActiveOrgId(session)

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
    projectIds: formData.getAll("projectIds").map(String).filter(Boolean),
    jobTitle: values.jobTitle,
    payoutMethod: values.payoutMethod,
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
    projectIds: parsed.data.projectIds,
    jobTitle: parsed.data.jobTitle,
    payoutMethod: parsed.data.payoutMethod,
    xeroConnectionId,
  })

  clearEmployeeStore(parsed.data.email)
  clearAdminStore(session.email)
  revalidatePath("/admin")
  revalidatePath("/admin/hierarchy")
  revalidatePath("/employee")
  revalidatePath("/employee/account")
  revalidatePath("/employee/review")

  return {
    ...createInitialHierarchyFormState({
      role: parsed.data.role,
      organizationId,
      project: values.project,
      jobTitle: parsed.data.jobTitle,
      payoutMethod: parsed.data.payoutMethod,
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
    project: String(formData.get("project") ?? "").trim(),
    jobTitle: String(formData.get("jobTitle") ?? "").trim(),
    payoutMethod: resolveEmployeePayoutMethod(
      role,
      String(formData.get("payoutMethod") ?? "").trim()
    ),
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

  const organizationId = resolveActiveOrgId(session)

  if (!organizationId) {
    return {
      ...createInitialAddHierarchyMemberFormState(values),
      status: "error",
      message: "Set up your organization in settings before adding employees.",
    }
  }

  const parsed = createMemberSchema.safeParse({
    ...values,
    projectIds: formData.getAll("projectIds").map(String).filter(Boolean),
    payoutMethod: values.payoutMethod,
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
      projectIds: parsed.data.projectIds,
      jobTitle: parsed.data.jobTitle,
      payoutMethod: parsed.data.payoutMethod,
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

  const organizationId = resolveActiveOrgId(session)

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
