"use server"

import { cookies } from "next/headers"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { SettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { clearAdminStore } from "@/lib/app-store"
import { getCurrentSession, updateCurrentSession } from "@/lib/auth/session"
import type { XeroTenant } from "@/lib/xero"
import { deleteXeroConnection } from "@/lib/xero"
import {
  syncOrganizationChartAccounts,
  syncOrganizationProjects,
} from "@/modules/organization/application/services/xero-connection.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

const XERO_PENDING_COOKIE = "claimguard_xero_pending"

const organizationSchema = z.object({
  organizationName: z.string().optional(),
})

const claimRunSchema = z.object({
  claimCutoffDay: z.coerce
    .number()
    .int("Use a whole number for the cutoff day.")
    .min(1, "Cutoff day must be between 1 and 28.")
    .max(28, "Cutoff day must be between 1 and 28."),
})

function revalidateAdminSurfaces() {
  revalidatePath("/admin")
  revalidatePath("/admin/settings")
  revalidatePath("/admin/hierarchy")
  revalidatePath("/employee")
  revalidatePath("/employee/account")
  revalidatePath("/employee/claims")
  revalidatePath("/employee/claims/new")
}

export async function saveOrganizationSettingsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return {
      status: "error",
      message: "Session expired. Please log in again.",
    }
  }

  const organizationName = String(formData.get("organizationName") ?? "").trim()

  // If the name is blank, nothing to save
  if (!organizationName) {
    return {
      status: "success",
      message: "No changes to save.",
    }
  }

  const parsed = organizationSchema.safeParse({ organizationName })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to save organization settings.",
    }
  }

  const organization = await organizationRepository.upsertAdminOrganization({
    adminUserId: session.userId,
    organizationName: parsed.data.organizationName!,
  })

  await updateCurrentSession({
    organizationId: organization.id,
    organizationName: organization.name,
  })

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return {
    status: "success",
    message: "Organization settings saved.",
  }
}

export async function syncXeroAccountsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return {
      status: "error",
      message: "Session expired. Please log in again.",
    }
  }

  const connectionId = String(formData.get("connectionId") ?? "").trim()

  if (!connectionId) {
    return {
      status: "error",
      message: "No Xero connection selected. Please select a connection first.",
    }
  }

  const result = await syncOrganizationChartAccounts(connectionId)

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return {
    status: result.ok ? "success" : "error",
    message: result.message,
  }
}

export async function syncXeroProjectsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return {
      status: "error",
      message: "Session expired. Please log in again.",
    }
  }

  const connectionId = String(formData.get("connectionId") ?? "").trim()

  if (!connectionId) {
    return {
      status: "error",
      message: "No Xero connection selected. Please select a connection first.",
    }
  }

  const result = await syncOrganizationProjects(connectionId)

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return {
    status: result.ok ? "success" : "error",
    message: result.message,
  }
}

export async function saveSelectableAccountsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return {
      status: "error",
      message: "Session expired. Please log in again.",
    }
  }

  if (!session.organizationId) {
    return {
      status: "error",
      message: "Create or assign an organization before enabling claim accounts.",
    }
  }

  const connectionId = String(formData.get("connectionId") ?? "").trim() || undefined

  const chartAccountIds = formData
    .getAll("chartAccountIds")
    .map((value) => String(value))
    .filter(Boolean)

  await organizationRepository.setSelectableChartAccounts({
    organizationId: session.organizationId,
    xeroConnectionId: connectionId,
    chartAccountIds,
  })

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return {
    status: "success",
    message: "Selectable claim accounts updated.",
  }
}

export async function switchActiveXeroConnectionAction(
  connectionId: string
): Promise<void> {
  await updateCurrentSession({ activeXeroConnectionId: connectionId || undefined })
  revalidatePath("/admin", "layout")
}

export async function createCustomAccountAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  if (!session.organizationId) {
    return { status: "error", message: "Create an organization before adding accounts." }
  }

  const code = String(formData.get("code") ?? "").trim()
  const name = String(formData.get("name") ?? "").trim()
  const type = String(formData.get("type") ?? "").trim() || undefined
  const isSelectable = formData.get("isSelectable") === "true"

  if (!code || !name) {
    return { status: "error", message: "Account code and name are required." }
  }

  try {
    await organizationRepository.createCustomChartAccount({
      organizationId: session.organizationId,
      code,
      name,
      type,
      isSelectable,
    })
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to create account.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { status: "success", message: "Custom account created." }
}

export async function deleteCustomAccountAction(
  id: string
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  if (!session.organizationId) {
    return { ok: false, message: "No organization found." }
  }

  try {
    await organizationRepository.deleteCustomChartAccount({
      id,
      organizationId: session.organizationId,
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to delete account.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { ok: true, message: "Custom account deleted." }
}

export async function selectXeroTenantAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const tenantId = String(formData.get("tenantId") ?? "").trim()
  if (!tenantId) {
    return { status: "error", message: "Please select a Xero organisation." }
  }

  const cookieStore = await cookies()
  const raw = cookieStore.get(XERO_PENDING_COOKIE)?.value

  if (!raw) {
    return {
      status: "error",
      message: "Selection expired. Please reconnect Xero and try again.",
    }
  }

  let pending: {
    accessToken: string
    refreshToken: string
    scope: string
    tokenType: string
    expiresAt: string
    tenants: XeroTenant[]
  }

  try {
    pending = JSON.parse(raw)
  } catch {
    return { status: "error", message: "Invalid session data. Please reconnect Xero." }
  }

  const tenant = pending.tenants.find((t) => t.tenantId === tenantId)
  if (!tenant) {
    return { status: "error", message: "Selected organisation not found. Please reconnect Xero." }
  }

  // Auto-create org from Xero tenant name if admin hasn't set one yet
  let organizationId = session.organizationId
  if (!organizationId) {
    const org = await organizationRepository.upsertAdminOrganization({
      adminUserId: session.userId,
      organizationName: tenant.tenantName,
    })
    organizationId = org.id
    await updateCurrentSession({ organizationId: org.id, organizationName: org.name })
  }

  const inUse = await organizationRepository.getInUseTenantIds(
    [tenant.tenantId],
    organizationId
  )
  if (inUse.length > 0) {
    return {
      status: "error",
      message: `"${tenant.tenantName}" is already connected to another organisation. Please select a different one.`,
    }
  }

  await organizationRepository.upsertXeroConnection({
    organizationId,
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName,
    tenantType: tenant.tenantType,
    accessToken: pending.accessToken,
    refreshToken: pending.refreshToken,
    scope: pending.scope,
    tokenType: pending.tokenType,
    accessTokenExpiresAt: new Date(pending.expiresAt),
    connectedByAdminId: session.userId,
  })

  // Revoke the non-selected connections from Xero so they no longer appear in
  // the developer portal's Connection management and can't be used to call the API.
  const othersToRevoke = pending.tenants.filter((t) => t.tenantId !== tenant.tenantId)
  await Promise.allSettled(
    othersToRevoke.map((t) => deleteXeroConnection(pending.accessToken, t.connectionId))
  )

  cookieStore.delete(XERO_PENDING_COOKIE)

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { status: "success", message: "Xero organisation connected successfully." }
}

export async function saveClaimRunSettingsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return {
      status: "error",
      message: "Session expired. Please log in again.",
    }
  }

  if (!session.organizationId) {
    return {
      status: "error",
      message: "Create or assign an organization before updating claim run settings.",
    }
  }

  const parsed = claimRunSchema.safeParse({
    claimCutoffDay: formData.get("claimCutoffDay"),
  })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to save claim run settings.",
    }
  }

  await organizationRepository.updateOrganizationClaimCutoff({
    organizationId: session.organizationId,
    claimCutoffDay: parsed.data.claimCutoffDay,
  })

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return {
    status: "success",
    message: "Claim run cutoff updated.",
  }
}
