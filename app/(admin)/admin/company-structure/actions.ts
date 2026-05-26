"use server"

import { revalidatePath } from "next/cache"
import { isAdminRole } from "@/lib/auth/types"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import type { BaseFormState } from "@/lib/form-state"
import {
  defaultModuleConfig,
  teamModules,
  type TeamModuleConfig,
} from "@/modules/organization/domain/models"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/// Pulls the moduleConfig out of a FormData. Each module is a comma-separated
/// list of layer numbers (e.g. CLAIMS = "1,3"). Falls back to default-all when
/// a key is missing.
function parseModuleConfigFromForm(
  formData: FormData,
  layerCount: number,
): TeamModuleConfig {
  const out = defaultModuleConfig(layerCount)
  for (const m of teamModules) {
    const raw = formData.get(`moduleConfig.${m}`)
    if (raw === null) continue
    const parts = String(raw)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => Number(p))
      .filter(
        (n) => Number.isInteger(n) && n >= 1 && n <= layerCount,
      )
    out[m] = Array.from(new Set(parts)).sort((a, b) => a - b)
  }
  return out
}

const createTeamSchema = z.object({
  projectId: z.string().min(1, "Pick a project."),
  name: z.string().min(1, "Team name is required."),
  layerCount: z.number().int().min(1).max(10),
  layerLabels: z.array(z.string()).optional(),
})

/**
 * Create-team returns the new team's id on success so the UI can flip
 * the editor from "create" to "edit" mode without the admin having to
 * find and click the new team in the list. `BaseFormState` is widened
 * with `createdTeamId` for that purpose.
 */
export type CreateTeamActionState = BaseFormState & {
  createdTeamId?: string
}

export async function createTeamAction(
  _previousState: CreateTeamActionState,
  formData: FormData,
): Promise<CreateTeamActionState> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Set up your organization in settings first." }
  }

  const layerCountRaw = Number(formData.get("layerCount") ?? 1)
  // Don't filter out empty strings — that shifts later layers up (e.g.
  // [Staff, "", Manager] would persist as [Staff, Manager], silently
  // mis-mapping L3 → L2). Keep position by string-coercing only.
  const parsed = createTeamSchema.safeParse({
    projectId: String(formData.get("projectId") ?? ""),
    name: String(formData.get("name") ?? "").trim(),
    layerCount: Number.isFinite(layerCountRaw) ? layerCountRaw : 1,
    layerLabels: formData.getAll("layerLabels").map((v) => String(v).trim()),
  })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid team data.",
    }
  }

  const moduleConfig = parseModuleConfigFromForm(formData, parsed.data.layerCount)

  let created: { id: string }
  try {
    created = await organizationRepository.createTeam({
      organizationId,
      projectId: parsed.data.projectId,
      name: parsed.data.name,
      layerCount: parsed.data.layerCount,
      layerLabels: parsed.data.layerLabels,
      moduleConfig,
    })
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Unable to create team."),
    }
  }

  // Bust the org-config Redis caches — the company-structure +
  // hierarchy page-data services cache the team list at
  // `org:{orgId}:config:page:*`, so without this the new team
  // wouldn't show up until the TTL expired (or the user navigated
  // away and back enough times to invalidate). Every other team
  // action (update / delete / membership) already does this; the
  // create action was the only path missing the bust.
  await bustOrgConfigCaches({ organizationId })

  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")
  revalidatePath("/admin/hierarchy")

  return {
    status: "success",
    message: "Team created.",
    createdTeamId: created.id,
  }
}

const updateTeamSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().min(1, "Team name is required."),
  layerCount: z.number().int().min(1).max(10),
  layerLabels: z.array(z.string()).optional(),
})

export async function updateTeamAction(
  _previousState: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Set up your organization in settings first." }
  }

  const layerCountRaw = Number(formData.get("layerCount") ?? 1)
  const parsed = updateTeamSchema.safeParse({
    teamId: String(formData.get("teamId") ?? ""),
    name: String(formData.get("name") ?? "").trim(),
    layerCount: Number.isFinite(layerCountRaw) ? layerCountRaw : 1,
    layerLabels: formData.getAll("layerLabels").map((v) => String(v).trim()),
  })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid team data.",
    }
  }

  const moduleConfig = parseModuleConfigFromForm(formData, parsed.data.layerCount)

  try {
    await organizationRepository.updateTeam({
      organizationId,
      teamId: parsed.data.teamId,
      name: parsed.data.name,
      layerCount: parsed.data.layerCount,
      layerLabels: parsed.data.layerLabels ?? null,
      moduleConfig,
    })
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Unable to update team."),
    }
  }

  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")
  revalidatePath("/admin/hierarchy")
  await bustOrgConfigCaches({ organizationId })

  return { status: "success", message: "Team updated." }
}

/**
 * Replace the project's manager set. Mirrors the project-edit form's
 * manager picker but exposed inline on the company-structure left
 * column. The repo enforces "SUPERVISOR or ADMIN only" and "must belong
 * to this organization" — the picker UI will pre-filter to those roles
 * but the server-side check is the source of truth.
 */
const setProjectManagersSchema = z.object({
  projectId: z.string().min(1),
  /// userIds (NOT employeeProfileIds) — managers are User-row roles, not
  /// EmployeeProfile rows. The picker passes user.id values.
  managerUserIds: z.array(z.string().min(1)),
})

export async function setProjectManagersAction(
  _previousState: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Set up your organization in settings first." }
  }

  const parsed = setProjectManagersSchema.safeParse({
    projectId: String(formData.get("projectId") ?? ""),
    // FormData carries multiple values under one key as separate entries;
    // use getAll() so a 0-, 1-, or N-manager picker all serialize cleanly.
    managerUserIds: formData.getAll("managerUserIds").map((v) => String(v)),
  })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid managers payload.",
    }
  }

  try {
    await organizationRepository.updateProjectDetails({
      projectId: parsed.data.projectId,
      organizationId,
      projectManagerIds: parsed.data.managerUserIds,
    })
  } catch (error) {
    return {
      status: "error",
      message:
        safeErrorMessage(error, "Unable to update project managers."),
    }
  }

  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")
  revalidatePath("/admin/hierarchy")
  await bustOrgConfigCaches({ organizationId })

  return { status: "success", message: "Project managers updated." }
}

/**
 * Remove an employee from a project. Cascades through team memberships
 * + chain rows in the same project (defensive — by usage this is called
 * from the "unassigned employees" section, where the employee should
 * have no team memberships, but the cascade keeps things safe under
 * concurrent edits).
 */
const removeEmployeeFromProjectSchema = z.object({
  projectId: z.string().min(1),
  employeeProfileId: z.string().min(1),
})

export async function removeEmployeeFromProjectAction(
  _previousState: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Set up your organization in settings first." }
  }

  const parsed = removeEmployeeFromProjectSchema.safeParse({
    projectId: String(formData.get("projectId") ?? ""),
    employeeProfileId: String(formData.get("employeeProfileId") ?? ""),
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid request.",
    }
  }

  try {
    await organizationRepository.removeEmployeeFromProject({
      organizationId,
      projectId: parsed.data.projectId,
      employeeProfileId: parsed.data.employeeProfileId,
    })
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Unable to remove employee from project.",
    }
  }

  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")
  revalidatePath("/admin/hierarchy")
  await bustOrgConfigCaches({ organizationId })

  return { status: "success", message: "Employee removed from project." }
}

/**
 * Add an employee to a project. Creates the EmployeeProjectAssignment
 * row only — team assignment is a separate step (see
 * `assignTeamMemberAction`). Idempotent at the repo level (upsert on
 * the unique pair).
 */
const addEmployeeToProjectSchema = z.object({
  projectId: z.string().min(1),
  employeeProfileId: z.string().min(1),
})

export async function addEmployeeToProjectAction(
  _previousState: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Set up your organization in settings first." }
  }

  const parsed = addEmployeeToProjectSchema.safeParse({
    projectId: String(formData.get("projectId") ?? ""),
    employeeProfileId: String(formData.get("employeeProfileId") ?? ""),
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid assignment.",
    }
  }

  try {
    await organizationRepository.addEmployeeToProject({
      organizationId,
      projectId: parsed.data.projectId,
      employeeProfileId: parsed.data.employeeProfileId,
    })
  } catch (error) {
    return {
      status: "error",
      message:
        safeErrorMessage(error, "Unable to add employee to project."),
    }
  }

  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")
  revalidatePath("/admin/hierarchy")
  await bustOrgConfigCaches({ organizationId })

  return { status: "success", message: "Employee added to project." }
}

/**
 * Add a member to a team OR move an existing member to a different
 * layer. The underlying `assignTeamMember` repo method is an upsert keyed
 * on (employeeProfileId, teamId), so passing an existing pair simply
 * updates the layer field. Approval-chain rows are intentionally left
 * untouched on layer change — phase 1 keeps the existing chain and lets
 * the admin fix it via the per-employee form if it no longer makes
 * sense.
 */
const assignMemberSchema = z.object({
  teamId: z.string().min(1),
  employeeProfileId: z.string().min(1),
  layer: z.number().int().min(1).max(10),
})

export async function assignTeamMemberAction(
  _previousState: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Set up your organization in settings first." }
  }

  const layerRaw = Number(formData.get("layer") ?? 1)
  const parsed = assignMemberSchema.safeParse({
    teamId: String(formData.get("teamId") ?? ""),
    employeeProfileId: String(formData.get("employeeProfileId") ?? ""),
    layer: Number.isFinite(layerRaw) ? layerRaw : 1,
  })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Invalid assignment.",
    }
  }

  try {
    await organizationRepository.assignTeamMember({
      organizationId,
      employeeProfileId: parsed.data.employeeProfileId,
      teamId: parsed.data.teamId,
      layer: parsed.data.layer,
    })
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Unable to update team member."),
    }
  }

  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")
  revalidatePath("/admin/hierarchy")
  await bustOrgConfigCaches({ organizationId })

  return { status: "success", message: "Member updated." }
}

const removeMemberSchema = z.object({
  membershipId: z.string().min(1),
})

export async function removeTeamMemberAction(
  _previousState: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Set up your organization in settings first." }
  }

  const parsed = removeMemberSchema.safeParse({
    membershipId: String(formData.get("membershipId") ?? ""),
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Missing membership id.",
    }
  }

  try {
    // Repo does the org-scope check + cascades chain rows for this
    // (employee, team) tuple in the same transaction.
    await organizationRepository.removeTeamMember({
      organizationId,
      membershipId: parsed.data.membershipId,
    })
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Unable to remove member."),
    }
  }

  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")
  revalidatePath("/admin/hierarchy")
  await bustOrgConfigCaches({ organizationId })

  return { status: "success", message: "Member removed." }
}

export async function deleteTeamAction(
  _previousState: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Set up your organization in settings first." }
  }

  const teamId = String(formData.get("teamId") ?? "").trim()
  if (!teamId) {
    return { status: "error", message: "Missing team id." }
  }

  try {
    await organizationRepository.deleteTeam({ organizationId, teamId })
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Unable to delete team."),
    }
  }

  // Mirror every other team mutation in this file: bust the
  // org-config Redis caches so the company-structure + hierarchy
  // page-data services re-fetch from the DB on next render. Without
  // this the deleted team would linger in the cached list until the
  // TTL expired — same symptom we just fixed for createTeamAction.
  await bustOrgConfigCaches({ organizationId })

  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")
  revalidatePath("/admin/hierarchy")

  return { status: "success", message: "Team deleted." }
}
