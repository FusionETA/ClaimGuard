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
  supervisorId: z.string().optional(),
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
  supervisorId: z.string().optional(),
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
    supervisorId: String(formData.get("supervisorId") ?? ""),
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

  if (!session.organizationId) {
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
    supervisorId: values.supervisorId || undefined,
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
    organizationId: session.organizationId,
    project: parsed.data.project || undefined,
    jobTitle: parsed.data.jobTitle,
    supervisorId: parsed.data.supervisorId || undefined,
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
      organizationId: session.organizationId,
      project: parsed.data.project ?? "",
      jobTitle: parsed.data.jobTitle,
      supervisorId: parsed.data.supervisorId ?? "",
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
    supervisorId: String(formData.get("supervisorId") ?? ""),
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

  if (!session.organizationId) {
    return {
      ...createInitialAddHierarchyMemberFormState(values),
      status: "error",
      message: "Set up your organization in settings before adding employees.",
    }
  }

  const parsed = createMemberSchema.safeParse({
    ...values,
    project: values.project || undefined,
    supervisorId: values.supervisorId || undefined,
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
      organizationId: session.organizationId,
      project: parsed.data.project || undefined,
      jobTitle: parsed.data.jobTitle,
      supervisorId: parsed.data.supervisorId || undefined,
      xeroConnectionId,
    })
  } catch (error) {
    return {
      ...createInitialAddHierarchyMemberFormState(values),
      status: "error",
      message:
        error instanceof Error ? error.message : "Unable to create employee right now.",
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
