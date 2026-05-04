"use server"

import { cookies } from "next/headers"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import type { SettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { clearAdminStore } from "@/lib/app-store"
import { geocodeAddress } from "@/lib/geocode"
import { getCurrentSession, resolveActiveOrgId, updateCurrentSession } from "@/lib/auth/session"
import type { XeroTenant } from "@/lib/xero"
import { deleteXeroConnection } from "@/lib/xero"
import {
  disconnectXeroConnection,
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

const otRateMultiplier = z.coerce
  .number({ message: "Rates must be a number." })
  .min(1, "Rates must be at least 1.0×.")
  .max(10, "Rates must be at most 10.0×.")

const otRatesSchema = z.object({
  otRateNormalDay: otRateMultiplier,
  otRateRestDay: otRateMultiplier,
  otRatePublicHoliday: otRateMultiplier,
  restDayInShiftRate: otRateMultiplier,
  publicHolidayInShiftRate: otRateMultiplier,
  otSalaryThreshold: z.coerce
    .number({ message: "Threshold must be a number." })
    .min(0, "Threshold must be 0 or greater.")
    .max(1_000_000, "Threshold seems unrealistic."),
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

  const organizationId = resolveActiveOrgId(session)

  const organization = organizationId
    ? await organizationRepository.updateOrganizationName({
        adminId: session.userId,
        organizationId,
        organizationName: parsed.data.organizationName!,
      })
    : await organizationRepository.upsertAdminOrganization({
        adminUserId: session.userId,
        organizationName: parsed.data.organizationName!,
      })

  await updateCurrentSession(
    organizationId && organizationId !== session.organizationId
      ? {}
      : {
          organizationId: organization.id,
          organizationName: organization.name,
        }
  )

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

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
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
    organizationId,
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

export async function switchActiveOrganizationAction(
  organizationId: string
): Promise<void> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return

  // Verify the admin actually belongs to this org before switching
  const isAdmin = await organizationRepository.isAdminOfOrganization(session.userId, organizationId)
  if (!isAdmin) return

  // Clear active Xero connection when switching org — the new org has its own
  await updateCurrentSession({
    activeOrganizationId: organizationId,
    activeXeroConnectionId: undefined,
  })
  clearAdminStore(session.email)
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

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
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
      organizationId,
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

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { ok: false, message: "No organization found." }
  }

  try {
    await organizationRepository.deleteCustomChartAccount({
      id,
      organizationId,
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
  let organizationId = resolveActiveOrgId(session)
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

  const existingConnections = await organizationRepository.getXeroConnections(organizationId)
  const hasDifferentExistingConnection = existingConnections.some(
    (connection) => connection.tenantId !== tenant.tenantId
  )

  if (hasDifferentExistingConnection) {
    return {
      status: "error",
      message:
        "This company is already connected to a different Xero organization. Disconnect the current one before connecting a new one.",
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

export async function disconnectXeroAction(
  connectionId: string
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { ok: false, message: "No organization found." }
  }

  const result = await disconnectXeroConnection({
    connectionId,
    organizationId,
  })

  if (result.ok) {
    clearAdminStore(session.email)
    revalidateAdminSurfaces()
  }

  return result
}

export async function createOrganizationAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const name = String(formData.get("name") ?? "").trim()
  if (!name) {
    return { status: "error", message: "Organization name is required." }
  }

  try {
    const org = await organizationRepository.createAdminOrganization({
      adminId: session.userId,
      name,
    })

    // Switch to the newly created organization
    await updateCurrentSession(
      session.organizationId
        ? { activeOrganizationId: org.id }
        : {
            organizationId: org.id,
            organizationName: org.name,
            activeOrganizationId: org.id,
          }
    )
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to create organization.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { status: "success", message: "Organization created." }
}

export async function switchOrganizationAction(organizationId: string): Promise<void> {
  await updateCurrentSession({ activeOrganizationId: organizationId })
  revalidatePath("/admin", "layout")
}

export async function saveSelectedBankAccountsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No organization selected." }
  }

  const connectionId = String(formData.get("connectionId") ?? "").trim() || undefined
  const chartAccountIds = formData.getAll("bankAccountIds").map(String).filter(Boolean)

  await organizationRepository.setSelectedBankAccounts({
    organizationId,
    xeroConnectionId: connectionId,
    chartAccountIds,
  })

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { status: "success", message: "Bank accounts updated." }
}

export async function createManualProjectAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Create an organization first." }
  }

  const name = String(formData.get("name") ?? "").trim()
  const rawPm = String(formData.get("projectManagerId") ?? "").trim()
  const projectManagerId = rawPm && rawPm !== "__none" ? rawPm : undefined
  const location = String(formData.get("location") ?? "").trim() || undefined
  const rawLat = parseFloat(String(formData.get("latitude") ?? ""))
  const rawLng = parseFloat(String(formData.get("longitude") ?? ""))
  let latitude: number | undefined = isNaN(rawLat) ? undefined : rawLat
  let longitude: number | undefined = isNaN(rawLng) ? undefined : rawLng

  if (!name) {
    return { status: "error", message: "Project name is required." }
  }

  // If the admin typed an address but didn't pin coordinates (no 📍 button
  // press, no "lat, lng" string), geocode it server-side so the project still
  // gets coords for distance / map features.
  if (location && (latitude === undefined || longitude === undefined)) {
    const resolved = await geocodeAddress(location)
    if (resolved) {
      latitude = resolved.lat
      longitude = resolved.lng
    }
  }

  try {
    await organizationRepository.createManualProject({
      organizationId,
      name,
      projectManagerId,
      location,
      latitude,
      longitude,
    })
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to create project.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { status: "success", message: "Project created." }
}

export async function updateProjectAction(
  projectId: string,
  projectManagerId: string | undefined,
  location: string | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { ok: false, message: "No organization found." }
  }

  // If the admin typed an address but didn't pin coordinates (no 📍 button,
  // no "lat, lng" string), geocode it server-side so the project still gets
  // coords. Mirrors the create flow.
  let resolvedLat = latitude
  let resolvedLng = longitude
  if (location && (resolvedLat == null || resolvedLng == null)) {
    const geo = await geocodeAddress(location)
    if (geo) {
      resolvedLat = geo.lat
      resolvedLng = geo.lng
    }
  }

  try {
    await organizationRepository.updateProjectDetails({
      projectId,
      organizationId,
      projectManagerId: projectManagerId || undefined,
      location: location || undefined,
      latitude: resolvedLat ?? null,
      longitude: resolvedLng ?? null,
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to update project.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { ok: true, message: "Project updated." }
}

export async function deleteManualProjectAction(
  projectId: string
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { ok: false, message: "No organization found." }
  }

  try {
    await organizationRepository.deleteManualProject({
      projectId,
      organizationId,
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Unable to delete project.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { ok: true, message: "Project deleted." }
}

export async function saveBankAccountAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Create an organization before adding a bank account." }
  }

  const bankAccount = String(formData.get("bankAccount") ?? "").trim()

  try {
    await organizationRepository.updateOrganizationBankAccount({
      organizationId,
      bankAccount,
    })
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to save bank account.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { status: "success", message: "Bank account saved." }
}

export async function deleteBankAccountAction(): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { ok: false, message: "No organization found." }
  }

  await organizationRepository.updateOrganizationBankAccount({ organizationId, bankAccount: "" })

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { ok: true, message: "Bank account cleared." }
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

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
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
    organizationId,
    claimCutoffDay: parsed.data.claimCutoffDay,
  })

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return {
    status: "success",
    message: "Claim run cutoff updated.",
  }
}

// ----------------------------------------------------------------------------
// Mileage claim settings
// ----------------------------------------------------------------------------

const mileageDefaultsSchema = z.object({
  defaultMileageRate: z
    .union([
      z
        .string()
        .trim()
        .transform((v) => (v === "" ? undefined : Number(v)))
        .refine((v) => v === undefined || (Number.isFinite(v) && v >= 0), {
          message: "Rate must be 0 or greater.",
        }),
      z.number().nonnegative(),
    ])
    .optional(),
  mileageUnit: z.enum(["KM", "MILE"]).default("KM"),
})

export async function saveMileageDefaultsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Create or assign an organization first." }
  }

  const parsed = mileageDefaultsSchema.safeParse({
    defaultMileageRate: formData.get("defaultMileageRate"),
    mileageUnit: formData.get("mileageUnit") ?? "KM",
  })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to save mileage defaults.",
    }
  }

  try {
    await organizationRepository.updateOrganizationMileageDefaults({
      organizationId,
      defaultMileageRate: parsed.data.defaultMileageRate,
      mileageUnit: parsed.data.mileageUnit,
    })
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to save mileage defaults.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { status: "success", message: "Mileage defaults saved." }
}

/**
 * Bulk-save which accounts are mileage-eligible plus optional per-account
 * rate overrides. The form posts paired arrays:
 *   mileageAccountIds[] — selected account ids
 *   mileageRate__<accountId> — optional decimal override
 */
export async function saveMileageAccountsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No organization selected." }
  }

  const connectionId = String(formData.get("connectionId") ?? "").trim() || undefined

  const selectedIds = formData
    .getAll("mileageAccountIds")
    .map((value) => String(value))
    .filter(Boolean)

  const selectedAccounts: Array<{ chartAccountId: string; mileageRate?: number }> = []
  for (const id of selectedIds) {
    const raw = String(formData.get(`mileageRate__${id}`) ?? "").trim()
    if (raw === "") {
      selectedAccounts.push({ chartAccountId: id })
      continue
    }
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) {
      return {
        status: "error",
        message: "Mileage rate overrides must be 0 or greater.",
      }
    }
    selectedAccounts.push({ chartAccountId: id, mileageRate: n })
  }

  try {
    await organizationRepository.setMileageChartAccounts({
      organizationId,
      xeroConnectionId: connectionId,
      selectedAccounts,
    })
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to save mileage accounts.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { status: "success", message: "Mileage claim accounts saved." }
}

// ----------------------------------------------------------------------------
// Per-account spend-limit setting
// ----------------------------------------------------------------------------

const limitSchema = z
  .object({
    chartOfAccountId: z.string().min(1),
    limitAmount: z
      .string()
      .trim()
      .transform((v) => (v === "" ? undefined : Number(v)))
      .refine((v) => v === undefined || (Number.isFinite(v) && v > 0), {
        message: "Limit must be a positive number.",
      })
      .optional(),
    limitPeriod: z
      .enum(["", "PER_CLAIM", "MONTHLY", "YEARLY"])
      .transform((v) => (v === "" ? undefined : v))
      .optional(),
    limitScope: z
      .enum(["", "PER_EMPLOYEE", "ORG_WIDE"])
      .transform((v) => (v === "" ? undefined : v))
      .optional(),
  })
  .superRefine((data, ctx) => {
    const hasAny =
      data.limitAmount !== undefined ||
      data.limitPeriod !== undefined ||
      data.limitScope !== undefined
    const hasAll =
      data.limitAmount !== undefined &&
      data.limitPeriod !== undefined &&
      data.limitScope !== undefined
    if (hasAny && !hasAll) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide amount, period, and scope to set a limit (or clear all to remove).",
      })
    }
  })

export async function saveAccountLimitAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No organization selected." }
  }

  const parsed = limitSchema.safeParse({
    chartOfAccountId: formData.get("chartOfAccountId") ?? "",
    limitAmount: formData.get("limitAmount") ?? "",
    limitPeriod: formData.get("limitPeriod") ?? "",
    limitScope: formData.get("limitScope") ?? "",
  })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to save limit.",
    }
  }

  try {
    await organizationRepository.updateChartAccountLimit({
      organizationId,
      chartOfAccountId: parsed.data.chartOfAccountId,
      limitAmount: parsed.data.limitAmount,
      limitPeriod: parsed.data.limitPeriod,
      limitScope: parsed.data.limitScope,
    })
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to save limit.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return { status: "success", message: "Account limit updated." }
}

export async function saveOtRatesAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return {
      status: "error",
      message: "Create or assign an organization before updating OT rates.",
    }
  }

  const parsed = otRatesSchema.safeParse({
    otRateNormalDay: formData.get("otRateNormalDay"),
    otRateRestDay: formData.get("otRateRestDay"),
    otRatePublicHoliday: formData.get("otRatePublicHoliday"),
    restDayInShiftRate: formData.get("restDayInShiftRate"),
    publicHolidayInShiftRate: formData.get("publicHolidayInShiftRate"),
    otSalaryThreshold: formData.get("otSalaryThreshold"),
  })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to save OT rates.",
    }
  }

  try {
    await organizationRepository.updateOrganizationOtRates({
      organizationId,
      rates: {
        normalDay: parsed.data.otRateNormalDay,
        restDay: parsed.data.otRateRestDay,
        publicHoliday: parsed.data.otRatePublicHoliday,
        restDayInShift: parsed.data.restDayInShiftRate,
        publicHolidayInShift: parsed.data.publicHolidayInShiftRate,
        salaryThreshold: parsed.data.otSalaryThreshold,
      },
    })
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unable to save OT rates.",
    }
  }

  clearAdminStore(session.email)
  revalidateAdminSurfaces()

  return {
    status: "success",
    message: "OT rates updated.",
  }
}
