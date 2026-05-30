"use server"

import { cookies } from "next/headers"
import { isAdminRole, isOwnerRole } from "@/lib/auth/types"
import { safeErrorMessage } from "@/lib/errors"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import type {
  SettingsActionState,
  InviteAdminActionState,
} from "@/app/(admin)/admin/settings/form-state"
import { generateApiToken } from "@/lib/api-auth"
import { isKnownApiScope, type ApiScope } from "@/lib/api-scopes"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { getCurrentSession, resolveActiveOrgId, updateCurrentSession } from "@/lib/auth/session"
import { isKnownCurrency } from "@/lib/currencies"
import type { XeroTenant } from "@/lib/xero"
import { deleteXeroConnection } from "@/lib/xero"
import { apiIntegrationRepository } from "@/modules/organization/infrastructure/api-integration.repository"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import {
  disconnectXeroConnection,
  setXeroTrackingCategoryForConnection,
  syncOrganizationChartAccounts,
  syncOrganizationProjects,
} from "@/modules/organization/application/services/xero-connection.service"
import {
  importCustomChartAccountsCsv,
  importManualProjectsCsv,
  type CsvImportResult,
} from "@/modules/organization/application/services/csv-import.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"

const XERO_PENDING_COOKIE = "claimguard_xero_pending"
// Cookie that persists the admin's currently-selected Xero connection id
// across requests. Multiple admin pages read this as a fallback when the
// session's activeXeroConnectionId isn't set. When the active org changes,
// the cookie has to be deleted too — otherwise pages pick up a connection
// id that belongs to the previous org and queries return zero rows.
const ACTIVE_CONNECTION_COOKIE = "claimguard_active_connection"

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

const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine((code) => isKnownCurrency(code), {
    message: "Currency must be from the supported list.",
  })

const currenciesSchema = z
  .object({
    allowedCurrencies: z.array(currencyCodeSchema).min(1, "Pick at least one currency."),
    defaultCurrency: currencyCodeSchema,
  })
  .superRefine((data, ctx) => {
    if (!data.allowedCurrencies.includes(data.defaultCurrency)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultCurrency"],
        message: "Default must be one of the selected currencies.",
      })
    }
  })

// otRatesSchema removed alongside saveOtRatesAction — OT multipliers
// live on EmployeePolicy now. See Settings → Policies.

/**
 * Revalidate Next.js render cache + bust Redis config caches for an
 * org. Pass `organizationId` whenever the calling action has it
 * resolved — that lets us nuke `org:{id}:config:*` keys (admin page
 * data, form helpers) so the next page load reflects the change. When
 * orgId isn't available (e.g. session-level mutation), only Next.js
 * paths are revalidated.
 */
async function revalidateAdminSurfaces(organizationId?: string) {
  revalidatePath("/admin")
  revalidatePath("/admin/settings")
  revalidatePath("/admin/hierarchy")
  revalidatePath("/employee")
  revalidatePath("/employee/account")
  revalidatePath("/employee/claims")
  revalidatePath("/employee/claims/new")
  if (organizationId) {
    await bustOrgConfigCaches({ organizationId })
  }
}

export async function saveOrganizationSettingsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
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

  void writeAudit({
    organizationId: organization.id,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "settings.org.update",
    status: "SUCCESS",
    summary: `Updated organization name to "${parsed.data.organizationName!}"`,
    targetType: "organization",
    targetId: organization.id,
    metadata: { organizationName: parsed.data.organizationName },
  })

  await revalidateAdminSurfaces(organizationId)

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

  if (!session || !isAdminRole(session.role)) {
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

  await revalidateAdminSurfaces(resolveActiveOrgId(session) ?? undefined)

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

  if (!session || !isAdminRole(session.role)) {
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

  await revalidateAdminSurfaces(resolveActiveOrgId(session) ?? undefined)

  return {
    status: result.ok ? "success" : "error",
    message: result.message,
  }
}

/**
 * Save the admin's picked Xero Tracking Category for a connection.
 * Passes `null` clears the pick. Does NOT trigger a sync — the admin
 * presses "Sync now" separately after picking.
 */
export async function saveXeroTrackingCategoryAction(
  _previousState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const connectionId = String(formData.get("connectionId") ?? "").trim()
  if (!connectionId) {
    return { status: "error", message: "No Xero connection selected." }
  }
  const raw = String(formData.get("xeroTrackingCategoryId") ?? "").trim()
  const xeroTrackingCategoryId = raw === "" ? null : raw

  const result = await setXeroTrackingCategoryForConnection({
    connectionId,
    xeroTrackingCategoryId,
  })

  if (!result.ok) {
    return { status: "error", message: result.message ?? "Could not save pick." }
  }

  await revalidateAdminSurfaces(resolveActiveOrgId(session) ?? undefined)

  return {
    status: "success",
    message: xeroTrackingCategoryId
      ? `Tracking category set to "${result.name}". Click "Sync now" to import its options.`
      : "Tracking category cleared. Project sync will stay paused until you pick one.",
  }
}

export async function saveSelectableAccountsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
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

  await revalidateAdminSurfaces(organizationId)

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
  if (!session || !isAdminRole(session.role)) return

  // Verify the admin actually belongs to this org before switching
  const isAdmin = await organizationRepository.isAdminOfOrganization(session.userId, organizationId)
  if (!isAdmin) return

  // Clear active Xero connection when switching org — the new org has its own
  await updateCurrentSession({
    activeOrganizationId: organizationId,
    activeXeroConnectionId: undefined,
  })

  // Also delete the active-connection cookie. Several admin pages read it
  // as a fallback when the session value is undefined; if we leave it
  // pointing at the previous org's connection, queries on the new org
  // will mismatch and return zero rows (e.g. "No selectable accounts
  // configured" on the Sync page).
  const cookieStore = await cookies()
  cookieStore.delete(ACTIVE_CONNECTION_COOKIE)

  revalidatePath("/admin", "layout")
}

export async function createCustomAccountAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
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
      message: safeErrorMessage(error, "Unable to create account."),
    }
  }

  await revalidateAdminSurfaces(organizationId)

  return { status: "success", message: "Custom account created." }
}

/**
 * Bulk-import custom chart of accounts from a CSV file. Append-only:
 * rows whose `code` already exists are skipped. Returns row-level
 * counts + errors so the admin sees exactly what happened.
 *
 * Only meaningful in custom mode (no Xero connection) — Xero-connected
 * orgs sync their COA from Xero instead. The UI hides this button when
 * a Xero connection exists.
 */
export type ImportCsvActionResult =
  | ({ status: "success" } & CsvImportResult)
  | { status: "error"; message: string }

export async function importCustomChartAccountsAction(
  _previousState: ImportCsvActionResult | null,
  formData: FormData,
): Promise<ImportCsvActionResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Create an organization before importing accounts." }
  }

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Pick a CSV file to upload." }
  }

  let csvText: string
  try {
    csvText = await file.text()
  } catch {
    return { status: "error", message: "Could not read the file. Make sure it's a plain-text CSV." }
  }

  let result: CsvImportResult
  try {
    result = await importCustomChartAccountsCsv({ organizationId, csvText })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Import failed."),
    }
  }

  if (result.imported > 0) {
    await revalidateAdminSurfaces(organizationId)
  }

  return { status: "success", ...result }
}

/**
 * Bulk-import manual projects from a CSV file. Append-only: rows whose
 * `name` already exists in the org are skipped. Project managers are
 * NOT settable via CSV — the admin attaches them per-project after
 * import.
 */
export async function importManualProjectsAction(
  _previousState: ImportCsvActionResult | null,
  formData: FormData,
): Promise<ImportCsvActionResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Create an organization before importing projects." }
  }

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Pick a CSV file to upload." }
  }

  let csvText: string
  try {
    csvText = await file.text()
  } catch {
    return { status: "error", message: "Could not read the file. Make sure it's a plain-text CSV." }
  }

  let result: CsvImportResult
  try {
    result = await importManualProjectsCsv({ organizationId, csvText })
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Import failed."),
    }
  }

  if (result.imported > 0) {
    await revalidateAdminSurfaces(organizationId)
  }

  return { status: "success", ...result }
}

export async function deleteCustomAccountAction(
  id: string
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
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
      message: safeErrorMessage(error, "Unable to delete account."),
    }
  }

  await revalidateAdminSurfaces(organizationId)

  return { ok: true, message: "Custom account deleted." }
}

export async function selectXeroTenantAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
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
    xeroConnectionId: tenant.connectionId,
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

  await revalidateAdminSurfaces(organizationId)

  return { status: "success", message: "Xero organisation connected successfully." }
}

export async function disconnectXeroAction(
  connectionId: string
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
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
      void writeAudit({
        organizationId,
        actor: {
          userId: session.userId,
          email: session.email,
          name: session.name,
          role: session.role,
        },
        action: "xero.disconnect",
        status: "SUCCESS",
        summary: "Disconnected Xero",
        targetType: "xero-connection",
        targetId: connectionId,
      })
      await revalidateAdminSurfaces(organizationId)
  } else {
    void writeAudit({
      organizationId,
      actor: {
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
      },
      action: "xero.disconnect",
      status: "FAILED",
      summary: "Tried to disconnect Xero",
      errorReason: result.message,
      targetType: "xero-connection",
      targetId: connectionId,
    })
  }

  return result
}

export async function createOrganizationAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
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
      message: safeErrorMessage(error, "Unable to create organization."),
    }
  }

  // Org was just created — resolve the freshly-set activeOrganizationId
  // from the updated session to bust the new org's config caches (none
  // exist yet, but this future-proofs against late writes).
  const refreshedSession = await getCurrentSession()
  await revalidateAdminSurfaces(
    refreshedSession ? resolveActiveOrgId(refreshedSession) ?? undefined : undefined,
  )

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

  if (!session || !isAdminRole(session.role)) {
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

  await revalidateAdminSurfaces(organizationId)

  return { status: "success", message: "Bank accounts updated." }
}

export async function createManualProjectAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "Create an organization first." }
  }

  const name = String(formData.get("name") ?? "").trim()
  // Project managers — multi-select. Form sends one `projectManagerIds`
  // entry per picked PM. Drop the legacy "__none" sentinel and any blanks.
  const projectManagerIds = formData
    .getAll("projectManagerIds")
    .map((v) => String(v).trim())
    .filter((v) => v && v !== "__none")
  const rawLat = parseFloat(String(formData.get("latitude") ?? ""))
  const rawLng = parseFloat(String(formData.get("longitude") ?? ""))
  const latitude = Number.isFinite(rawLat) ? rawLat : undefined
  const longitude = Number.isFinite(rawLng) ? rawLng : undefined

  if (!name) {
    return { status: "error", message: "Project name is required." }
  }
  if (latitude != null && (latitude < -90 || latitude > 90)) {
    return { status: "error", message: "Latitude must be between -90 and 90." }
  }
  if (longitude != null && (longitude < -180 || longitude > 180)) {
    return { status: "error", message: "Longitude must be between -180 and 180." }
  }
  const location =
    latitude != null && longitude != null
      ? `${latitude.toFixed(6)},${longitude.toFixed(6)}`
      : undefined

  try {
    await organizationRepository.createManualProject({
      organizationId,
      name,
      projectManagerIds,
      location,
      latitude,
      longitude,
    })
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Unable to create project."),
    }
  }

  await revalidateAdminSurfaces(organizationId)

  return { status: "success", message: "Project created." }
}

export async function updateProjectAction(
  projectId: string,
  projectManagerIds: string[] | undefined,
  location: string | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { ok: false, message: "No organization found." }
  }

  if (latitude != null && (latitude < -90 || latitude > 90)) {
    return { ok: false, message: "Latitude must be between -90 and 90." }
  }
  if (longitude != null && (longitude < -180 || longitude > 180)) {
    return { ok: false, message: "Longitude must be between -180 and 180." }
  }

  // Derive canonical location string from coords; fall back to caller-provided
  // value (currently always undefined from the new UI, but kept for safety).
  const derivedLocation =
    latitude != null && longitude != null
      ? `${latitude.toFixed(6)},${longitude.toFixed(6)}`
      : location || undefined

  try {
    await organizationRepository.updateProjectDetails({
      projectId,
      organizationId,
      projectManagerIds,
      location: derivedLocation,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
    })
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, "Unable to update project."),
    }
  }

  await revalidateAdminSurfaces(organizationId)

  return { ok: true, message: "Project updated." }
}

export async function deleteManualProjectAction(
  projectId: string
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
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
      message: safeErrorMessage(error, "Unable to delete project."),
    }
  }

  await revalidateAdminSurfaces(organizationId)

  return { ok: true, message: "Project deleted." }
}

export async function saveClaimRunSettingsAction(
  _previousState: SettingsActionState,
  formData: FormData
): Promise<SettingsActionState> {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
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

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "settings.claim-run.update",
    status: "SUCCESS",
    summary: `Set claim-run cutoff to day ${parsed.data.claimCutoffDay} of the month`,
    targetType: "organization",
    targetId: organizationId,
    metadata: { claimCutoffDay: parsed.data.claimCutoffDay },
  })

  await revalidateAdminSurfaces(organizationId)

  return {
    status: "success",
    message: "Claim run cutoff updated.",
  }
}

// ----------------------------------------------------------------------------
// Currency settings
// ----------------------------------------------------------------------------

/**
 * Save the org's currency policy. The form posts:
 *   - allowedCurrencies as repeated form fields ("USD", "MYR", ...)
 *   - defaultCurrency as a single radio value
 * superRefine ensures the default is in the allowed set.
 */
export async function saveCurrencySettingsAction(
  _previousState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return {
      status: "error",
      message: "Create or assign an organization before saving currency settings.",
    }
  }

  const allowedCurrencies = formData
    .getAll("allowedCurrencies")
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0)

  const parsed = currenciesSchema.safeParse({
    allowedCurrencies,
    defaultCurrency: String(formData.get("defaultCurrency") ?? "").trim(),
  })

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to save currency settings.",
    }
  }

  await organizationRepository.updateOrganizationCurrencies({
    organizationId,
    allowedCurrencies: parsed.data.allowedCurrencies,
    defaultCurrency: parsed.data.defaultCurrency,
  })

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "settings.currency.update",
    status: "SUCCESS",
    summary: `Set currencies: default ${parsed.data.defaultCurrency}; allowed ${parsed.data.allowedCurrencies.join(", ")}`,
    targetType: "organization",
    targetId: organizationId,
    metadata: {
      defaultCurrency: parsed.data.defaultCurrency,
      allowedCurrencies: parsed.data.allowedCurrencies,
    },
  })

  await revalidateAdminSurfaces(organizationId)

  return {
    status: "success",
    message: "Currency settings saved.",
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

  if (!session || !isAdminRole(session.role)) {
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
      message: safeErrorMessage(error, "Unable to save mileage defaults."),
    }
  }

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "settings.mileage.update",
    status: "SUCCESS",
    summary: `Set default mileage rate to RM ${parsed.data.defaultMileageRate ?? 0}/${parsed.data.mileageUnit}`,
    targetType: "organization",
    targetId: organizationId,
    metadata: {
      defaultMileageRate: parsed.data.defaultMileageRate,
      mileageUnit: parsed.data.mileageUnit,
    },
  })

  await revalidateAdminSurfaces(organizationId)

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

  if (!session || !isAdminRole(session.role)) {
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
      message: safeErrorMessage(error, "Unable to save mileage accounts."),
    }
  }

  await revalidateAdminSurfaces(organizationId)

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

  if (!session || !isAdminRole(session.role)) {
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
      message: safeErrorMessage(error, "Unable to save limit."),
    }
  }

  await revalidateAdminSurfaces(organizationId)

  return { status: "success", message: "Account limit updated." }
}

// saveOtRatesAction was removed — OT multipliers now live on
// EmployeePolicy (see Settings → Policies). The form that used to write
// to Organization.otRate* has also been removed from admin-settings-panel.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

async function assertProjectInActiveOrg(projectId: string) {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false as const, message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { ok: false as const, message: "No organization found." }
  }
  const belongs = await organizationRepository.projectBelongsToOrg(
    projectId,
    organizationId,
  )
  if (!belongs) return { ok: false as const, message: "Project not found." }
  return { ok: true as const, session, organizationId }
}

export async function saveOrgWorkingHoursAction(
  start: string,
  end: string
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) return { ok: false, message: "No organization found." }

  if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
    return { ok: false, message: "Times must be HH:MM (24h)." }
  }
  if (start >= end) {
    return { ok: false, message: "Start time must be before end time." }
  }

  try {
    await attendanceRepository.setWorkingHours(organizationId, start, end)
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, "Unable to save working hours."),
    }
  }

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "settings.working-hours.update",
    status: "SUCCESS",
    summary: `Set org working hours to ${start}–${end}`,
    targetType: "organization",
    targetId: organizationId,
    metadata: { start, end },
  })

  await revalidateAdminSurfaces(organizationId)
  return { ok: true, message: "Default working hours saved." }
}

export async function saveOrgTimezoneAction(
  timezone: string
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) return { ok: false, message: "No organization found." }

  const { isValidTimezone } = await import(
    "@/modules/attendance/domain/timezone"
  )
  if (!isValidTimezone(timezone)) {
    return { ok: false, message: "Unknown timezone." }
  }

  try {
    await attendanceRepository.setTimezone(organizationId, timezone)
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, "Unable to save timezone."),
    }
  }

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "settings.timezone.update",
    status: "SUCCESS",
    summary: `Set org timezone to ${timezone}`,
    targetType: "organization",
    targetId: organizationId,
    metadata: { timezone },
  })

  await revalidateAdminSurfaces(organizationId)
  return { ok: true, message: "Timezone saved." }
}

export async function toggleOrgOtAction(
  enabled: boolean
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) return { ok: false, message: "No organization found." }

  try {
    await organizationRepository.setOrganizationOtEnabled(organizationId, enabled)
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, "Unable to update OT setting."),
    }
  }

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: enabled ? "settings.ot.enable" : "settings.ot.disable",
    status: "SUCCESS",
    summary: enabled ? "Enabled organisation OT" : "Disabled organisation OT",
    targetType: "organization",
    targetId: organizationId,
  })

  await revalidateAdminSurfaces(organizationId)
  return { ok: true, message: enabled ? "Overtime enabled." : "Overtime disabled." }
}

export async function saveSupervisorReportSettingsAction(
  enabled: boolean,
  slaMinutes: number,
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) return { ok: false, message: "No organization found." }
  if (!Number.isFinite(slaMinutes) || slaMinutes < 1 || slaMinutes > 24 * 60) {
    return { ok: false, message: "SLA minutes must be between 1 and 1440." }
  }

  try {
    await organizationRepository.setSupervisorReportSettings(
      organizationId,
      enabled,
      Math.round(slaMinutes),
    )
  } catch (error) {
    return {
      ok: false,
      message:
        safeErrorMessage(error, "Unable to save supervisor report settings."),
    }
  }

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "settings.supervisor-reports.update",
    status: "SUCCESS",
    summary: `Supervisor reports ${enabled ? "enabled" : "disabled"} (SLA ${Math.round(slaMinutes)} min)`,
    targetType: "organization",
    targetId: organizationId,
    metadata: { enabled, slaMinutes: Math.round(slaMinutes) },
  })

  await revalidateAdminSurfaces(organizationId)
  return { ok: true, message: "Supervisor report settings saved." }
}

export async function saveGeofenceRadiusAction(
  meters: number
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) return { ok: false, message: "No organization found." }
  if (!Number.isFinite(meters) || meters < 10 || meters > 10000) {
    return { ok: false, message: "Radius must be between 10 and 10000 metres." }
  }

  try {
    await organizationRepository.setGeofenceRadius(
      organizationId,
      Math.round(meters),
    )
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, "Unable to update geofence radius."),
    }
  }

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "settings.geofence-radius.update",
    status: "SUCCESS",
    summary: `Set geofence radius to ${Math.round(meters)}m`,
    targetType: "organization",
    targetId: organizationId,
    metadata: { meters: Math.round(meters) },
  })

  await revalidateAdminSurfaces(organizationId)
  return { ok: true, message: `Geofence radius set to ${Math.round(meters)} m.` }
}

export async function saveProjectCalendarAction(
  projectId: string,
  values: {
    workingHoursStart: string | null
    workingHoursEnd: string | null
    workingDays: string | null
    lunchBreakMinutes?: number | null
  }
): Promise<{ ok: boolean; message: string }> {
  const ctx = await assertProjectInActiveOrg(projectId)
  if (!ctx.ok) return ctx

  const { workingHoursStart, workingHoursEnd, workingDays, lunchBreakMinutes } = values

  if (workingHoursStart && !TIME_RE.test(workingHoursStart)) {
    return { ok: false, message: "Start time must be HH:MM (24h)." }
  }
  if (workingHoursEnd && !TIME_RE.test(workingHoursEnd)) {
    return { ok: false, message: "End time must be HH:MM (24h)." }
  }
  if (workingHoursStart && workingHoursEnd && workingHoursStart >= workingHoursEnd) {
    return { ok: false, message: "Start time must be before end time." }
  }
  if (workingDays !== null && workingDays !== "") {
    const days = workingDays.split(",").map((d) => d.trim())
    for (const d of days) {
      const n = Number(d)
      if (!Number.isInteger(n) || n < 1 || n > 7) {
        return { ok: false, message: "Working days must be a comma-separated list of 1–7." }
      }
    }
  }
  let lunchToPersist: number | undefined
  if (lunchBreakMinutes !== undefined && lunchBreakMinutes !== null) {
    if (
      !Number.isFinite(lunchBreakMinutes) ||
      lunchBreakMinutes < 0 ||
      lunchBreakMinutes > 240
    ) {
      return {
        ok: false,
        message: "Lunch break must be between 0 and 240 minutes.",
      }
    }
    lunchToPersist = Math.round(lunchBreakMinutes)
  }

  try {
    await organizationRepository.updateProjectCalendar(projectId, {
      workingHoursStart: workingHoursStart || null,
      workingHoursEnd: workingHoursEnd || null,
      workingDays: workingDays || null,
      lunchBreakMinutes: lunchToPersist,
    })
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, "Unable to save calendar."),
    }
  }

  await revalidateAdminSurfaces(ctx.organizationId)
  return { ok: true, message: "Calendar saved." }
}

export async function addProjectHolidayAction(
  projectId: string,
  date: string,
  name: string
): Promise<{ ok: boolean; message: string }> {
  const ctx = await assertProjectInActiveOrg(projectId)
  if (!ctx.ok) return ctx

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, message: "Date must be YYYY-MM-DD." }
  }
  const trimmed = name.trim()
  if (!trimmed) {
    return { ok: false, message: "Holiday name is required." }
  }

  try {
    await organizationRepository.upsertProjectHoliday({
      projectId,
      date: new Date(date),
      name: trimmed,
    })
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, "Unable to add holiday."),
    }
  }

  await revalidateAdminSurfaces(ctx.organizationId)
  return { ok: true, message: "Holiday added." }
}

export type HolidayApiSource = "nager" | "calendarific"

async function fetchNagerHolidays(
  year: number,
  countryCode: string
): Promise<{ ok: true; holidays: Array<{ date: string; name: string }> } | { ok: false; message: string }> {
  try {
    const res = await fetch(
      `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`,
      { cache: "no-store" }
    )
    if (!res.ok) {
      return { ok: false, message: `date.nager.at returned ${res.status}.` }
    }
    const raw = (await res.json()) as Array<{
      date: string
      localName?: string
      name?: string
    }>
    return {
      ok: true,
      holidays: raw
        .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date))
        .map((h) => ({
          date: h.date,
          name: (h.localName || h.name || "Public holiday").trim(),
        })),
    }
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, "Could not reach date.nager.at."),
    }
  }
}

async function fetchCalendarificHolidays(
  year: number,
  countryCode: string
): Promise<{ ok: true; holidays: Array<{ date: string; name: string }> } | { ok: false; message: string }> {
  const key = process.env.CALENDARIFIC_API_KEY
  if (!key) {
    return {
      ok: false,
      message:
        "Calendarific requires CALENDARIFIC_API_KEY in your environment. Get a free key at calendarific.com.",
    }
  }
  try {
    const url = `https://calendarific.com/api/v2/holidays?api_key=${key}&country=${countryCode}&year=${year}&type=national`
    const res = await fetch(url, { cache: "no-store" })
    if (!res.ok) {
      return { ok: false, message: `Calendarific returned ${res.status}.` }
    }
    const data = (await res.json()) as {
      response?: {
        holidays?: Array<{
          name?: string
          date?: { iso?: string }
        }>
      }
      meta?: { code?: number; error_detail?: string }
    }
    if (data.meta?.code && data.meta.code !== 200) {
      return {
        ok: false,
        message: data.meta.error_detail || `Calendarific error ${data.meta.code}.`,
      }
    }
    const list = data.response?.holidays ?? []
    return {
      ok: true,
      holidays: list
        .map((h) => {
          const iso = (h.date?.iso ?? "").slice(0, 10)
          return /^\d{4}-\d{2}-\d{2}$/.test(iso)
            ? { date: iso, name: (h.name || "Public holiday").trim() }
            : null
        })
        .filter((h): h is { date: string; name: string } => h !== null),
    }
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, "Could not reach Calendarific."),
    }
  }
}

export async function importProjectHolidaysAction(
  projectId: string,
  year: number,
  countryCode: string
): Promise<{ ok: boolean; message: string; imported?: number }> {
  const ctx = await assertProjectInActiveOrg(projectId)
  if (!ctx.ok) return ctx

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { ok: false, message: "Year must be between 2000 and 2100." }
  }
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { ok: false, message: "Country code must be 2 uppercase letters (e.g. MY)." }
  }

  // Try Calendarific first when a key is configured (richer, esp. for MY).
  // Fall back to date.nager.at on failure or when no key is set.
  let usedSource: HolidayApiSource = "nager"
  let result = process.env.CALENDARIFIC_API_KEY
    ? await fetchCalendarificHolidays(year, countryCode)
    : await fetchNagerHolidays(year, countryCode)
  if (result.ok && process.env.CALENDARIFIC_API_KEY) usedSource = "calendarific"

  if (!result.ok) {
    if (usedSource === "calendarific") {
      const fallback = await fetchNagerHolidays(year, countryCode)
      if (fallback.ok) {
        result = fallback
        usedSource = "nager"
      } else {
        return { ok: false, message: result.message }
      }
    } else {
      return { ok: false, message: result.message }
    }
  }
  if (result.holidays.length === 0) {
    return { ok: false, message: "No holidays returned for that year." }
  }

  // De-duplicate by date — Calendarific can return the same date multiple times
  // (e.g. when a regional holiday and a national holiday fall on the same day).
  const dedupedByDate = new Map<string, string>()
  for (const h of result.holidays) {
    if (!dedupedByDate.has(h.date)) dedupedByDate.set(h.date, h.name)
  }

  let imported = 0
  for (const [date, name] of dedupedByDate) {
    try {
      await organizationRepository.upsertProjectHoliday({
        projectId,
        date: new Date(date),
        name,
      })
      imported += 1
    } catch {
      // skip individual failures, continue with rest
    }
  }

  const sourceLabel = usedSource === "calendarific" ? "Calendarific" : "date.nager.at"
  await revalidateAdminSurfaces(ctx.organizationId)
  return {
    ok: true,
    message: `Imported ${imported} holidays for ${countryCode} ${year} (${sourceLabel}).`,
    imported,
  }
}

export async function deleteProjectHolidayAction(
  holidayId: string
): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) return { ok: false, message: "No organization found." }

  try {
    const removed = await organizationRepository.deleteProjectHolidayInOrg(
      holidayId,
      organizationId,
    )
    if (!removed) return { ok: false, message: "Holiday not found." }
  } catch (error) {
    return {
      ok: false,
      message: safeErrorMessage(error, "Unable to delete holiday."),
    }
  }

  await revalidateAdminSurfaces(organizationId)
  return { ok: true, message: "Holiday removed." }
}

// ----------------------------------------------------------------------------
// Multi-admin: create another admin for the active organization
// ----------------------------------------------------------------------------

const inviteAdminSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .email("Enter a valid email address.")
    .toLowerCase(),
  name: z.string().trim().max(120, "Name is too long.").optional(),
  password: z.string().max(128, "Password is too long.").optional(),
  confirm: z.boolean().optional(),
})

/**
 * Owner-only: invite an admin to the ACTIVE organization, by email.
 *
 * Three outcomes:
 *  - Email is brand new       → create a new ADMIN (name + temp password
 *    required) tied to this org.
 *  - Email is an existing admin/owner NOT yet on this org → ask the owner
 *    to confirm (status "confirm"); on resubmit with confirm=true, link
 *    them to this org via AdminOrganization (no new account, no password).
 *  - Email is an existing admin already on this org, or a non-admin user
 *    → friendly error.
 *
 * Owners are seed/master-only, so this never creates owners — only admins.
 */
export async function createAdminAction(
  _previousState: InviteAdminActionState,
  formData: FormData,
): Promise<InviteAdminActionState> {
  const session = await getCurrentSession()
  if (!session) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  if (!isOwnerRole(session.role)) {
    return {
      status: "error",
      message: "Only the owner can add or remove admins.",
    }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return {
      status: "error",
      message:
        "Pick or create an organization before adding more admins to it.",
    }
  }

  const parsed = inviteAdminSchema.safeParse({
    email: formData.get("email") ?? "",
    name: formData.get("name") ?? "",
    password: formData.get("password") ?? "",
    confirm: formData.get("confirm") === "true",
  })
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Unable to add admin.",
    }
  }
  const { email, name, password, confirm } = parsed.data

  try {
    const existing = await organizationRepository.findUserByEmail(email)

    if (existing) {
      // Existing account must be an admin/owner to be granted org access.
      if (existing.role !== "ADMIN" && existing.role !== "OWNER") {
        return {
          status: "error",
          message:
            "That email belongs to a non-admin user in the system. Use a different email for the admin.",
        }
      }

      const alreadyHere = await organizationRepository.isAdminOfOrganization(
        existing.id,
        organizationId,
      )
      if (alreadyHere) {
        return {
          status: "error",
          message: `${existing.name} is already an admin of this organisation.`,
        }
      }

      // Known admin from another org — confirm before linking.
      if (!confirm) {
        return {
          status: "confirm",
          message: `${existing.name} (${existing.email}) is already an admin of another organisation. Add them to this organisation too?`,
          confirm: { name: existing.name, email: existing.email },
        }
      }

      await organizationRepository.linkAdminToOrganization(
        existing.id,
        organizationId,
      )
      await revalidateAdminSurfaces(organizationId)
      return {
        status: "success",
        message: `${existing.name} now has admin access to this organisation.`,
      }
    }

    // Brand-new admin — name + temp password required.
    if (!name || name.length === 0) {
      return { status: "error", message: "Name is required for a new admin." }
    }
    if (!password || password.length < 8) {
      return {
        status: "error",
        message: "Temporary password must be at least 8 characters.",
      }
    }

    await organizationRepository.createAdminForOrganization({
      organizationId,
      email,
      name,
      password,
    })
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Could not add admin."),
    }
  }

  await revalidateAdminSurfaces(organizationId)
  return {
    status: "success",
    message: "New admin invited. They can sign in with the temp password.",
  }
}

/**
 * Owner-only: remove an admin's access to the ACTIVE organization.
 * Deletes their AdminOrganization link for this org (the user account
 * stays — they may still administer other orgs). Refuses to remove the
 * owner or the current user themselves.
 */
export async function removeAdminAction(
  _previousState: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const session = await getCurrentSession()
  if (!session) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  if (!isOwnerRole(session.role)) {
    return {
      status: "error",
      message: "Only the owner can add or remove admins.",
    }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No active organisation." }
  }

  const adminId = String(formData.get("adminId") ?? "").trim()
  if (!adminId) {
    return { status: "error", message: "Missing admin id." }
  }
  if (adminId === session.userId) {
    return { status: "error", message: "You can't remove yourself." }
  }

  try {
    const target = await organizationRepository.findUserByEmail(
      String(formData.get("email") ?? ""),
    )
    if (target && target.role === "OWNER") {
      return { status: "error", message: "The owner can't be removed." }
    }
    await organizationRepository.unlinkAdminFromOrganization(
      adminId,
      organizationId,
    )
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Could not remove admin."),
    }
  }

  await revalidateAdminSurfaces(organizationId)
  return { status: "success", message: "Admin access removed." }
}

// ----------------------------------------------------------------------------
// External API integrations
// ----------------------------------------------------------------------------

const apiTokenCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters.")
    .max(80, "Name is too long."),
  scopes: z
    .array(z.string())
    .min(1, "Pick at least one scope.")
    .refine(
      (scopes) => scopes.every((s) => isKnownApiScope(s)),
      { message: "One or more scopes are not recognised." },
    ),
})

/**
 * Create a new API token for the active organisation. Returns the raw
 * token in `secretToken` — this is the ONLY time the raw value is
 * exposed; the admin must copy it now or revoke and recreate. The
 * persisted row stores only the SHA-256 hash.
 *
 * Token shape: `wp_live_<32 hex chars>`. Prefix `wp_live_` is just a
 * branding signal so a leaked credential is recognisable in logs/code.
 */
export async function createApiTokenAction(formData: FormData): Promise<{
  ok: boolean
  message: string
  /** Only present on success — show in UI exactly once, then forget. */
  secretToken?: string
  /** Last 4 chars of the secret — useful for the post-create dialog. */
  prefix?: string
}> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return {
      ok: false,
      message: "Pick or create an organization before adding API tokens.",
    }
  }

  const scopesRaw = formData.getAll("scopes").map(String).filter(Boolean)
  const parsed = apiTokenCreateSchema.safeParse({
    name: formData.get("name") ?? "",
    scopes: scopesRaw,
  })

  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Could not create token.",
    }
  }

  const { raw, hash, prefix } = generateApiToken()

  try {
    await apiIntegrationRepository.create({
      organizationId,
      name: parsed.data.name,
      tokenHash: hash,
      tokenPrefix: prefix,
      // Cast is safe — the schema refine guaranteed every entry is a
      // known scope.
      scopes: parsed.data.scopes as ApiScope[],
    })
  } catch (error) {
    void writeAudit({
      organizationId,
      actor: {
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
      },
      action: "api.token.create",
      status: "FAILED",
      summary: `Tried to mint API token "${parsed.data.name}"`,
      errorReason: safeErrorMessage(error, "Unknown DB error"),
      metadata: { prefix, scopes: parsed.data.scopes },
    })
    return {
      ok: false,
      message:
        safeErrorMessage(error, "Could not create token."),
    }
  }

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "api.token.create",
    status: "SUCCESS",
    summary: `Minted API token "${parsed.data.name}" (${prefix}…)`,
    targetType: "api-token",
    targetId: prefix,
    metadata: { scopes: parsed.data.scopes },
  })

  await revalidateAdminSurfaces(organizationId)

  return {
    ok: true,
    message: "Token created. Copy the secret now — it won't be shown again.",
    secretToken: raw,
    prefix,
  }
}

/** Toggle an integration's `active` flag without deleting it. Useful if
 *  you want to pause an integration temporarily without re-issuing a
 *  token to the partner. */
export async function setApiTokenActiveAction(input: {
  integrationId: string
  active: boolean
}): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { ok: false, message: "No active organization." }
  }

  const result = await apiIntegrationRepository.setActive({
    organizationId,
    integrationId: input.integrationId,
    active: input.active,
  })

  if (!result.ok) {
    return { ok: false, message: "Token not found." }
  }

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: input.active ? "api.token.enable" : "api.token.revoke",
    status: "SUCCESS",
    summary: input.active
      ? "Re-enabled API token"
      : "Revoked API token",
    targetType: "api-token",
    targetId: input.integrationId,
  })

  await revalidateAdminSurfaces(organizationId)
  return {
    ok: true,
    message: input.active ? "Token re-enabled." : "Token revoked.",
  }
}

/** Hard delete — also drops the audit log rows for that integration via
 *  cascade. Prefer `setApiTokenActiveAction(false)` if you might want to
 *  re-enable later. */
export async function deleteApiTokenAction(input: {
  integrationId: string
}): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { ok: false, message: "No active organization." }
  }

  const result = await apiIntegrationRepository.deleteForOrganization({
    organizationId,
    integrationId: input.integrationId,
  })

  if (!result.ok) {
    return { ok: false, message: "Token not found." }
  }

  void writeAudit({
    organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "api.token.delete",
    status: "SUCCESS",
    summary: "Permanently deleted API token (audit logs preserved by cascade)",
    targetType: "api-token",
    targetId: input.integrationId,
  })

  await revalidateAdminSurfaces(organizationId)
  return { ok: true, message: "Token deleted." }
}
