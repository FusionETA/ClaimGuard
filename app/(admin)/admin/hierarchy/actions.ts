"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { clearAdminStore, clearEmployeeStore } from "@/lib/app-store"
import { getCurrentSession } from "@/lib/auth/session"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

const hierarchySchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["EMPLOYEE", "SUPERVISOR"]),
  project: z.string().min(1, "Project is required."),
  jobTitle: z.string().min(1, "Job title is required."),
  supervisorId: z.string().optional(),
  email: z.string().email(),
})

export async function updateHierarchyAction(formData: FormData) {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return
  }

  const parsed = hierarchySchema.safeParse({
    userId: String(formData.get("userId") ?? ""),
    role: String(formData.get("role") ?? "EMPLOYEE"),
    project: String(formData.get("project") ?? "").trim(),
    jobTitle: String(formData.get("jobTitle") ?? "").trim(),
    supervisorId: String(formData.get("supervisorId") ?? ""),
    email: String(formData.get("email") ?? ""),
  })

  if (!parsed.success) {
    return
  }

  await claimRepository.updateOrganizationMember({
    userId: parsed.data.userId,
    role: parsed.data.role,
    project: parsed.data.project,
    jobTitle: parsed.data.jobTitle,
    supervisorId: parsed.data.supervisorId || undefined,
  })

  clearEmployeeStore(parsed.data.email)
  clearAdminStore()
  revalidatePath("/admin")
  revalidatePath("/admin/hierarchy")
  revalidatePath("/employee")
  revalidatePath("/employee/review")
}
