import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { safeErrorMessage } from "@/lib/errors"
import {
  employeePayoutMethods,
  otPayoutMethods,
} from "@/modules/organization/domain/models"
import type { EmployeePolicy } from "@/modules/policy/domain/models"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"

/**
 * Employee policies collection. Policies are admin-configurable
 * classifications attached to each employee — they decide salary type
 * (hourly vs monthly), OT behaviour, attendance gating (geofence /
 * selfie), and module access (attendance / claims / leave).
 *
 * One policy per org is flagged as `isDefault` — that's the policy
 * new employees inherit unless an explicit `policyId` is passed when
 * the employee is created.
 */

/**
 * GET /api/v1/policies
 *
 * Required scope: `policies:read`. Returns every policy in the org —
 * including archived ones, so external systems can show "deactivated"
 * policies in their UI. Filter via `?archived=false` to suppress them.
 */
export const GET = handleApiRequest(
  ["policies:read"],
  async (request, ctx) => {
    const url = new URL(request.url)
    const archivedParam = url.searchParams.get("archived")

    const all = await policyRepository.listForOrganization(
      ctx.integration.organizationId,
    )

    // Default: include archived. Pass ?archived=false to hide them.
    const filtered =
      archivedParam === "false" ? all.filter((p) => !p.archived) : all

    return NextResponse.json({
      data: filtered.map(toExternalPolicy),
      total: filtered.length,
    })
  },
)

/**
 * Body schema for POST. The OT-rate fields are required even when
 * `otEnabled` is false — the calc engine reads them from the row
 * regardless and just ignores them outside `otMethod === "CASH"` mode.
 * Forcing values up front means partners can't accidentally create a
 * policy that later breaks when OT is toggled on.
 */
const createPolicySchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  description: z.string().trim().max(1000).optional(),

  // Module access
  canAccessAttendance: z.boolean(),
  canAccessClaims: z.boolean(),
  canAccessLeave: z.boolean(),

  // Compensation + OT
  salaryType: z.enum(employeePayoutMethods),
  otEnabled: z.boolean(),
  otMethod: z.enum(otPayoutMethods),

  // Attendance gating
  requireGeofence: z.boolean(),
  requireSelfie: z.boolean(),

  // Classification — temporary (probation / fixed-term) employees.
  temporary: z.boolean().default(false),

  // OT multipliers (always required — see file-level note)
  otRateNormalDay: z.number().nonnegative(),
  otRateRestDay: z.number().nonnegative(),
  otRatePublicHoliday: z.number().nonnegative(),
  otRateRestDayInShift: z.number().nonnegative(),
  otRatePublicHolidayInShift: z.number().nonnegative(),
  /// `null` = no cap, otherwise a positive MYR amount above which OT
  /// requires extra approval.
  otSalaryThreshold: z.number().nonnegative().nullable(),
  otDailyThresholdMinutes: z.number().int().nonnegative(),

  /// Optional. When true (or when this is the first policy in the
  /// org), this policy becomes the org's default. Defaults to false.
  isDefault: z.boolean().optional(),
})

/**
 * POST /api/v1/policies
 *
 * Required scope: `policies:write`. Creates a new policy in the
 * caller's org. The first policy ever created becomes the default
 * automatically; subsequent ones default to `isDefault: false` unless
 * the body explicitly sets `isDefault: true` (in which case the
 * previous default is demoted in the same transaction).
 */
export const POST = handleApiRequest(
  ["policies:write"],
  async (request, ctx) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = createPolicySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            status: 400,
            message: "Validation failed.",
            details: parsed.error.flatten(),
          },
        },
        { status: 400 },
      )
    }

    try {
      const created = await policyRepository.create({
        organizationId: ctx.integration.organizationId,
        name: parsed.data.name,
        description: parsed.data.description,
        canAccessAttendance: parsed.data.canAccessAttendance,
        canAccessClaims: parsed.data.canAccessClaims,
        canAccessLeave: parsed.data.canAccessLeave,
        salaryType: parsed.data.salaryType,
        otEnabled: parsed.data.otEnabled,
        otMethod: parsed.data.otMethod,
        requireGeofence: parsed.data.requireGeofence,
        requireSelfie: parsed.data.requireSelfie,
        temporary: parsed.data.temporary,
        otRateNormalDay: parsed.data.otRateNormalDay,
        otRateRestDay: parsed.data.otRateRestDay,
        otRatePublicHoliday: parsed.data.otRatePublicHoliday,
        otRateRestDayInShift: parsed.data.otRateRestDayInShift,
        otRatePublicHolidayInShift: parsed.data.otRatePublicHolidayInShift,
        otSalaryThreshold: parsed.data.otSalaryThreshold,
        otDailyThresholdMinutes: parsed.data.otDailyThresholdMinutes,
        isDefault: parsed.data.isDefault,
      })
      await bustOrgConfigCaches({
        organizationId: ctx.integration.organizationId,
      })
      return NextResponse.json(
        { data: toExternalPolicy(created) },
        { status: 201 },
      )
    } catch (error) {
      const message = safeErrorMessage(error, "Could not create policy.")
      return jsonError(409, message)
    }
  },
)

// ---------------------------------------------------------------------------
// Shared helpers (also imported by [id]/route.ts)
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

/**
 * Project an EmployeePolicy domain object into the external API shape.
 * Surfaces the full field list; flattens nothing so partners get a 1:1
 * view of what the admin UI also sees.
 */
export function toExternalPolicy(p: EmployeePolicy) {
  return {
    id: p.id,
    organizationId: p.organizationId,
    name: p.name,
    description: p.description ?? null,
    isDefault: p.isDefault,
    archived: p.archived,
    moduleAccess: {
      attendance: p.canAccessAttendance,
      claims: p.canAccessClaims,
      leave: p.canAccessLeave,
    },
    compensation: {
      salaryType: p.salaryType,
      otEnabled: p.otEnabled,
      otMethod: p.otMethod,
    },
    attendance: {
      requireGeofence: p.requireGeofence,
      requireSelfie: p.requireSelfie,
      temporary: p.temporary,
    },
    otRates: {
      normalDay: p.otRateNormalDay,
      restDay: p.otRateRestDay,
      publicHoliday: p.otRatePublicHoliday,
      restDayInShift: p.otRateRestDayInShift,
      publicHolidayInShift: p.otRatePublicHolidayInShift,
      salaryThreshold: p.otSalaryThreshold,
      dailyThresholdMinutes: p.otDailyThresholdMinutes,
    },
    /// Number of employees currently assigned to this policy. May be
    /// undefined when the source query didn't load counts.
    employeeCount: p.employeeCount ?? null,
  }
}
