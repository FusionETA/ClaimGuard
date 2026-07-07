"use server"

import { revalidatePath } from "next/cache"
import { isAdminRole } from "@/lib/auth/types"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import type { AuthenticatedSession } from "@/lib/auth/types"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { employeePayoutMethods } from "@/modules/organization/domain/models"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"

const baseSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(60, "Name too long."),
  description: z.string().trim().max(500).optional(),
  canAccessAttendance: z.boolean(),
  canAccessClaims: z.boolean(),
  canAccessLeave: z.boolean(),
  salaryType: z.enum(employeePayoutMethods),
  /// `NONE` means OT is disabled entirely; otherwise we record CASH or
  /// TIME_BANK and OT is enabled.
  otMode: z.enum(["NONE", "CASH", "TIME_BANK"]),
  requireGeofence: z.boolean(),
  requireIpWhitelist: z.boolean(),
  /// Master + per-event GPS capture flags. All optional in the Zod
  /// schema since the form might omit them on legacy templates; the
  /// repo's create/update writes a default of true when undefined.
  geolocationEnabled: z.boolean().optional(),
  captureLocationOnClockIn: z.boolean().optional(),
  captureLocationOnClockOut: z.boolean().optional(),
  captureLocationOnBreakStart: z.boolean().optional(),
  captureLocationOnBreakEnd: z.boolean().optional(),
  requireSelfie: z.boolean(),
  requireClockOutSelfie: z.boolean(),
  temporary: z.boolean(),
  autoClockOutEnabled: z.boolean(),
  autoClockOutAfterMin: z.coerce.number().int().min(1).max(1440).nullable(),
  otRateNormalDay: z.coerce.number().nonnegative().max(20),
  otRateRestDay: z.coerce.number().nonnegative().max(20),
  otRatePublicHoliday: z.coerce.number().nonnegative().max(20),
  otRateRestDayInShift: z.coerce.number().nonnegative().max(20),
  otRatePublicHolidayInShift: z.coerce.number().nonnegative().max(20),
  /// Optional cap; null means no cap is enforced.
  otSalaryThreshold: z.number().nonnegative().max(1_000_000).nullable(),
  otDailyThresholdMinutes: z.coerce.number().int().nonnegative().max(1440),
})

function splitOtMode(mode: "NONE" | "CASH" | "TIME_BANK"): {
  otEnabled: boolean
  otMethod: "CASH" | "TIME_BANK"
} {
  if (mode === "NONE") return { otEnabled: false, otMethod: "CASH" }
  return { otEnabled: true, otMethod: mode }
}

export type PolicyActionState = {
  status: "idle" | "success" | "error"
  message: string
}

async function requireOrgId(): Promise<
  | { session: AuthenticatedSession; organizationId: string }
  | { error: PolicyActionState }
> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { error: { status: "error", message: "Session expired. Please log in again." } }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { error: { status: "error", message: "Set up your organization in settings first." } }
  }
  return { session, organizationId }
}

function parseBoolFlag(formData: FormData, name: string): boolean {
  const value = formData.get(name)
  if (value === null) return false
  const str = String(value).toLowerCase()
  return str === "on" || str === "true" || str === "1"
}

/// Read a numeric form field, falling back to `defaultValue` when the
/// input is absent (e.g. the OT rates section isn't rendered because
/// the policy is in TIME_BANK mode). The `z.coerce` call still runs to
/// validate range — invalid strings will surface as Zod errors.
function readNumberWithDefault(
  formData: FormData,
  name: string,
  defaultValue: number,
): number {
  const raw = formData.get(name)
  if (raw === null || raw === "") return defaultValue
  return Number(raw)
}

const OT_RATE_DEFAULTS = {
  otRateNormalDay: 1.5,
  otRateRestDay: 2.0,
  otRatePublicHoliday: 3.0,
  otRateRestDayInShift: 1.0,
  otRatePublicHolidayInShift: 2.0,
  /// Daily threshold default, expressed as hours (the form input).
  otDailyThresholdHours: 8,
} as const

/// Read the optional salary cap. An empty / missing input means
/// "no cap" → null. A number means cap at that monthly salary.
function readOptionalSalaryThreshold(formData: FormData): number | null {
  const raw = formData.get("otSalaryThreshold")
  if (raw === null || String(raw).trim() === "") return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function readOtRates(formData: FormData) {
  const hours = readNumberWithDefault(
    formData,
    "otDailyThresholdHours",
    OT_RATE_DEFAULTS.otDailyThresholdHours,
  )
  return {
    otRateNormalDay: readNumberWithDefault(formData, "otRateNormalDay", OT_RATE_DEFAULTS.otRateNormalDay),
    otRateRestDay: readNumberWithDefault(formData, "otRateRestDay", OT_RATE_DEFAULTS.otRateRestDay),
    otRatePublicHoliday: readNumberWithDefault(formData, "otRatePublicHoliday", OT_RATE_DEFAULTS.otRatePublicHoliday),
    otRateRestDayInShift: readNumberWithDefault(formData, "otRateRestDayInShift", OT_RATE_DEFAULTS.otRateRestDayInShift),
    otRatePublicHolidayInShift: readNumberWithDefault(formData, "otRatePublicHolidayInShift", OT_RATE_DEFAULTS.otRatePublicHolidayInShift),
    otSalaryThreshold: readOptionalSalaryThreshold(formData),
    // Form captures hours; storage is minutes. Round to nearest integer
    // so half-hour values land cleanly.
    otDailyThresholdMinutes: Math.round(hours * 60),
  }
}

export async function createPolicyAction(
  _prev: PolicyActionState,
  formData: FormData,
): Promise<PolicyActionState> {
  const orgIdOrError = await requireOrgId()
  if ("error" in orgIdOrError) return orgIdOrError.error
  const { session, organizationId } = orgIdOrError

  const parsed = baseSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? "") || undefined,
    canAccessAttendance: parseBoolFlag(formData, "canAccessAttendance"),
    canAccessClaims: parseBoolFlag(formData, "canAccessClaims"),
    canAccessLeave: parseBoolFlag(formData, "canAccessLeave"),
    salaryType: String(formData.get("salaryType") ?? "HOURLY"),
    otMode: String(formData.get("otMode") ?? "CASH"),
    requireGeofence: parseBoolFlag(formData, "requireGeofence"),
    requireIpWhitelist: parseBoolFlag(formData, "requireIpWhitelist"),
    geolocationEnabled: parseBoolFlag(formData, "geolocationEnabled"),
    captureLocationOnClockIn: parseBoolFlag(formData, "captureLocationOnClockIn"),
    captureLocationOnClockOut: parseBoolFlag(formData, "captureLocationOnClockOut"),
    captureLocationOnBreakStart: parseBoolFlag(
      formData,
      "captureLocationOnBreakStart",
    ),
    captureLocationOnBreakEnd: parseBoolFlag(formData, "captureLocationOnBreakEnd"),
    requireSelfie: parseBoolFlag(formData, "requireSelfie"),
    requireClockOutSelfie: parseBoolFlag(formData, "requireClockOutSelfie"),
    temporary: parseBoolFlag(formData, "temporary"),
    autoClockOutEnabled: parseBoolFlag(formData, "autoClockOutEnabled"),
    autoClockOutAfterMin: formData.get("autoClockOutAfterMin")
      ? Number(formData.get("autoClockOutAfterMin"))
      : null,
    ...readOtRates(formData),
  })

  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid policy." }
  }

  const ot = splitOtMode(parsed.data.otMode)
  try {
    await policyRepository.create({
      organizationId,
      name: parsed.data.name,
      description: parsed.data.description,
      canAccessAttendance: parsed.data.canAccessAttendance,
      canAccessClaims: parsed.data.canAccessClaims,
      canAccessLeave: parsed.data.canAccessLeave,
      salaryType: parsed.data.salaryType,
      otEnabled: ot.otEnabled,
      otMethod: ot.otMethod,
      requireGeofence: parsed.data.requireGeofence,
      requireIpWhitelist: parsed.data.requireIpWhitelist,
      geolocationEnabled: parsed.data.geolocationEnabled,
      captureLocationOnClockIn: parsed.data.captureLocationOnClockIn,
      captureLocationOnClockOut: parsed.data.captureLocationOnClockOut,
      captureLocationOnBreakStart: parsed.data.captureLocationOnBreakStart,
      captureLocationOnBreakEnd: parsed.data.captureLocationOnBreakEnd,
      requireSelfie: parsed.data.requireSelfie,
      requireClockOutSelfie: parsed.data.requireClockOutSelfie,
      temporary: parsed.data.temporary,
      autoClockOutEnabled: parsed.data.autoClockOutEnabled,
      autoClockOutAfterMin: parsed.data.autoClockOutAfterMin,
      otRateNormalDay: parsed.data.otRateNormalDay,
      otRateRestDay: parsed.data.otRateRestDay,
      otRatePublicHoliday: parsed.data.otRatePublicHoliday,
      otRateRestDayInShift: parsed.data.otRateRestDayInShift,
      otRatePublicHolidayInShift: parsed.data.otRatePublicHolidayInShift,
      otSalaryThreshold: parsed.data.otSalaryThreshold,
      otDailyThresholdMinutes: parsed.data.otDailyThresholdMinutes,
    })
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Unable to create policy."),
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
    action: "policy.create",
    status: "SUCCESS",
    summary: `Created employee policy "${parsed.data.name}"`,
    targetType: "policy",
    metadata: { name: parsed.data.name, salaryType: parsed.data.salaryType, otMode: parsed.data.otMode },
  })

  await bustOrgConfigCaches({ organizationId })
  revalidatePath("/admin/settings")
  revalidatePath("/admin/hierarchy")
  return { status: "success", message: "Policy created." }
}

export async function updatePolicyAction(
  _prev: PolicyActionState,
  formData: FormData,
): Promise<PolicyActionState> {
  const orgIdOrError = await requireOrgId()
  if ("error" in orgIdOrError) return orgIdOrError.error
  const { session, organizationId } = orgIdOrError

  const id = String(formData.get("id") ?? "").trim()
  if (!id) return { status: "error", message: "Missing policy id." }

  const parsed = baseSchema.safeParse({
    name: String(formData.get("name") ?? ""),
    description: String(formData.get("description") ?? "") || undefined,
    canAccessAttendance: parseBoolFlag(formData, "canAccessAttendance"),
    canAccessClaims: parseBoolFlag(formData, "canAccessClaims"),
    canAccessLeave: parseBoolFlag(formData, "canAccessLeave"),
    salaryType: String(formData.get("salaryType") ?? "HOURLY"),
    otMode: String(formData.get("otMode") ?? "CASH"),
    requireGeofence: parseBoolFlag(formData, "requireGeofence"),
    requireIpWhitelist: parseBoolFlag(formData, "requireIpWhitelist"),
    geolocationEnabled: parseBoolFlag(formData, "geolocationEnabled"),
    captureLocationOnClockIn: parseBoolFlag(formData, "captureLocationOnClockIn"),
    captureLocationOnClockOut: parseBoolFlag(formData, "captureLocationOnClockOut"),
    captureLocationOnBreakStart: parseBoolFlag(
      formData,
      "captureLocationOnBreakStart",
    ),
    captureLocationOnBreakEnd: parseBoolFlag(formData, "captureLocationOnBreakEnd"),
    requireSelfie: parseBoolFlag(formData, "requireSelfie"),
    requireClockOutSelfie: parseBoolFlag(formData, "requireClockOutSelfie"),
    temporary: parseBoolFlag(formData, "temporary"),
    autoClockOutEnabled: parseBoolFlag(formData, "autoClockOutEnabled"),
    autoClockOutAfterMin: formData.get("autoClockOutAfterMin")
      ? Number(formData.get("autoClockOutAfterMin"))
      : null,
    ...readOtRates(formData),
  })

  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid policy." }
  }

  const ot = splitOtMode(parsed.data.otMode)
  try {
    await policyRepository.update({
      id,
      organizationId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      canAccessAttendance: parsed.data.canAccessAttendance,
      canAccessClaims: parsed.data.canAccessClaims,
      canAccessLeave: parsed.data.canAccessLeave,
      salaryType: parsed.data.salaryType,
      otEnabled: ot.otEnabled,
      otMethod: ot.otMethod,
      requireGeofence: parsed.data.requireGeofence,
      requireIpWhitelist: parsed.data.requireIpWhitelist,
      geolocationEnabled: parsed.data.geolocationEnabled,
      captureLocationOnClockIn: parsed.data.captureLocationOnClockIn,
      captureLocationOnClockOut: parsed.data.captureLocationOnClockOut,
      captureLocationOnBreakStart: parsed.data.captureLocationOnBreakStart,
      captureLocationOnBreakEnd: parsed.data.captureLocationOnBreakEnd,
      requireSelfie: parsed.data.requireSelfie,
      requireClockOutSelfie: parsed.data.requireClockOutSelfie,
      temporary: parsed.data.temporary,
      autoClockOutEnabled: parsed.data.autoClockOutEnabled,
      autoClockOutAfterMin: parsed.data.autoClockOutAfterMin,
      otRateNormalDay: parsed.data.otRateNormalDay,
      otRateRestDay: parsed.data.otRateRestDay,
      otRatePublicHoliday: parsed.data.otRatePublicHoliday,
      otRateRestDayInShift: parsed.data.otRateRestDayInShift,
      otRatePublicHolidayInShift: parsed.data.otRatePublicHolidayInShift,
      otSalaryThreshold: parsed.data.otSalaryThreshold,
      otDailyThresholdMinutes: parsed.data.otDailyThresholdMinutes,
    })
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Unable to update policy."),
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
    action: "policy.update",
    status: "SUCCESS",
    summary: `Updated employee policy "${parsed.data.name}"`,
    targetType: "policy",
    targetId: id,
    metadata: { name: parsed.data.name, salaryType: parsed.data.salaryType, otMode: parsed.data.otMode },
  })

  await bustOrgConfigCaches({ organizationId })
  revalidatePath("/admin/settings")
  revalidatePath("/admin/hierarchy")
  revalidatePath("/employee")
  return { status: "success", message: "Policy updated." }
}

export async function setDefaultPolicyAction(
  _prev: PolicyActionState,
  formData: FormData,
): Promise<PolicyActionState> {
  const orgIdOrError = await requireOrgId()
  if ("error" in orgIdOrError) return orgIdOrError.error
  const { session, organizationId } = orgIdOrError

  const id = String(formData.get("id") ?? "").trim()
  if (!id) return { status: "error", message: "Missing policy id." }

  try {
    await policyRepository.setDefault(id, organizationId)
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Unable to set default."),
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
    action: "policy.set-default",
    status: "SUCCESS",
    summary: "Set default employee policy",
    targetType: "policy",
    targetId: id,
  })

  revalidatePath("/admin/settings")
  return { status: "success", message: "Default policy updated." }
}

export async function archivePolicyAction(
  _prev: PolicyActionState,
  formData: FormData,
): Promise<PolicyActionState> {
  const orgIdOrError = await requireOrgId()
  if ("error" in orgIdOrError) return orgIdOrError.error
  const { session, organizationId } = orgIdOrError

  const id = String(formData.get("id") ?? "").trim()
  if (!id) return { status: "error", message: "Missing policy id." }

  try {
    await policyRepository.archive(id, organizationId)
  } catch (error) {
    return {
      status: "error",
      message: safeErrorMessage(error, "Unable to archive policy."),
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
    action: "policy.archive",
    status: "SUCCESS",
    summary: "Archived employee policy",
    targetType: "policy",
    targetId: id,
  })

  revalidatePath("/admin/settings")
  return { status: "success", message: "Policy archived." }
}
