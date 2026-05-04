"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { clearAdminStore } from "@/lib/app-store"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
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

export async function createTeamAction(
  _previousState: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
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

  try {
    await organizationRepository.createTeam({
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
      message: error instanceof Error ? error.message : "Unable to create team.",
    }
  }

  clearAdminStore(session.email)
  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")
  revalidatePath("/admin/hierarchy")

  return { status: "success", message: "Team created." }
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
  if (!session || session.role !== "ADMIN") {
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
      message: error instanceof Error ? error.message : "Unable to update team.",
    }
  }

  clearAdminStore(session.email)
  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")
  revalidatePath("/admin/hierarchy")

  return { status: "success", message: "Team updated." }
}

export async function deleteTeamAction(
  _previousState: BaseFormState,
  formData: FormData,
): Promise<BaseFormState> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
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
      message: error instanceof Error ? error.message : "Unable to delete team.",
    }
  }

  clearAdminStore(session.email)
  revalidatePath("/admin")
  revalidatePath("/admin/company-structure")

  return { status: "success", message: "Team deleted." }
}
