import "server-only"

import { safeErrorMessage } from "@/lib/errors"
import {
  invertWeekdayNames,
  weekdayNamesToCsv,
  type WeekdayName,
} from "@/lib/weekdays"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import type { PayrollSettingsData } from "@/modules/payroll/domain/settings"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import {
  policyRepository,
  type PolicyOtRateInput,
} from "@/modules/policy/infrastructure/policy.repository"

/**
 * One-shot payroll-policy setup for a freshly provisioned org.
 *
 * ## Why this exists
 *
 * The four fields a partner onboarding form collects live on four
 * different aggregates — Organization, PayrollSettings, EmployeePolicy
 * and XeroProject — at three different layers. Asking the partner to
 * fan that out themselves means the fan-out rule lives in our docs,
 * and the one that gets missed (OT rates apply to EVERY policy, not
 * just the default) produces wrong payslips for hourly staff with
 * nothing to indicate it. So the rule lives here instead.
 *
 * ## Scope: onboarding, not a general write path
 *
 * `overtime` writes to EVERY non-archived policy in the org. That is
 * correct for a client stating one company-wide OT policy on a setup
 * form, and wrong for an org where CS has since diverged a policy
 * deliberately. It is not a general-purpose OT endpoint — the
 * per-policy route (`PATCH /api/v1/policies/[id]`) stays the way to
 * change one group. The ids actually written are returned so a caller
 * can see the blast radius rather than infer it.
 *
 * ## Not atomic
 *
 * Each block is a separate repo write with no surrounding transaction,
 * matching every other write path in /api/v1. A block that throws is
 * recorded in `failed` and the remaining blocks still run — a bad
 * project id shouldn't cost the caller their OT rates. Every block is
 * idempotent, so re-sending the same body is the fix.
 *
 * Blocks are applied in a fixed order (settings, calculation,
 * overtime, workSchedule) so two identical requests behave identically.
 */

export type OnboardingBlock =
  | "settings"
  | "calculation"
  | "overtime"
  | "workSchedule"
  | "leave"

export type OnboardingSetupInput = {
  /// Org-wide working week. Exactly one of the two — the caller-facing
  /// route rejects both, since they write the same column.
  settings?: {
    workingDays?: WeekdayName[]
    nonWorkingDays?: WeekdayName[]
  }
  /// Payroll calculation rules. Same shape as the `calculation` block
  /// on `PATCH /api/v1/payroll-settings`.
  calculation?: {
    prorationBasis?: "TWENTY_SIX" | "CALENDAR"
    hrdf?: { contribute: boolean; rate?: number | null }
  }
  /// OT rates in the external vocabulary `GET /api/v1/policies`
  /// already returns (`otRates.normalDay`, …), so what you read back
  /// is what you send. Fans out to every non-archived policy.
  overtime?: {
    normalDay?: number
    restDay?: number
    publicHoliday?: number
    restDayInShift?: number
    publicHolidayInShift?: number
    salaryThreshold?: number | null
    /// Daily working minutes after which extra time becomes OT —
    /// the "normal hours per day" answer, x60.
    dailyThresholdMinutes?: number
  }
  /// Per-site working hours. Working DAYS are deliberately not here:
  /// `settings.workingDays` is the org-wide answer, and accepting a
  /// second working week in the same body invites a contradiction we
  /// would have to arbitrate. A site that genuinely differs uses
  /// `PATCH /api/v1/projects/[id]`.
  workSchedule?: {
    projectId?: string
    workingHoursStart?: string | null
    workingHoursEnd?: string | null
    lunchBreakMinutes?: number
  }
  /// Org-wide leave defaults, keyed by the seeded leave-type CODE
  /// (`ANNUAL`, `MEDICAL`, …) exactly like
  /// `PATCH /api/v1/leave-types`. Codes are matched
  /// case-insensitively.
  ///
  /// This writes `LeaveType` — the BOTTOM of the three-level
  /// entitlement chain (employee row → policy default → type default).
  /// `ensureEntitlement` creates an employee's row lazily on first
  /// access and snapshots `entitledDays` at that moment, so this is
  /// fully effective before staff start using the system and
  /// progressively weaker afterwards. Onboarding only.
  leave?: {
    entitlements?: Record<string, number>
    carryForward?: Record<
      string,
      { enabled: boolean; expiryMonth?: number | null; maxDays?: number | null }
    >
  }
}

export type OnboardingSetupResult = {
  applied: OnboardingBlock[]
  failed: Array<{ block: OnboardingBlock; message: string }>
  /// Policy ids the `overtime` block wrote to. Empty when the block
  /// was omitted or failed.
  policiesUpdated: string[]
  /// Project id the `workSchedule` block wrote to, if any.
  projectUpdated: string | null
  /// Leave-type codes the `leave` block wrote to. Empty when the block
  /// was omitted or failed.
  leaveTypesUpdated: string[]
}

export async function applyOnboardingSetup(args: {
  organizationId: string
  input: OnboardingSetupInput
}): Promise<OnboardingSetupResult> {
  const { organizationId, input } = args
  const applied: OnboardingBlock[] = []
  const failed: OnboardingSetupResult["failed"] = []
  let policiesUpdated: string[] = []
  let projectUpdated: string | null = null
  const leaveTypesUpdated: string[] = []

  const fail = (block: OnboardingBlock, error: unknown, fallback: string) => {
    failed.push({ block, message: safeErrorMessage(error, fallback) })
  }

  // ── settings ────────────────────────────────────────────────────────
  if (input.settings) {
    try {
      const week = resolveWorkingWeek(input.settings)
      if (week) {
        await organizationRepository.setOrgWorkingDays(
          organizationId,
          weekdayNamesToCsv(week),
        )
      }
      applied.push("settings")
    } catch (error) {
      fail("settings", error, "Could not update the working week.")
    }
  }

  // ── calculation ─────────────────────────────────────────────────────
  if (input.calculation) {
    try {
      const patch: Partial<
        Omit<
          PayrollSettingsData,
          "id" | "organizationId" | "createdAt" | "updatedAt"
        >
      > = {}
      if (input.calculation.prorationBasis !== undefined) {
        patch.workingDaysRule = input.calculation.prorationBasis
      }
      if (input.calculation.hrdf !== undefined) {
        const hrdf = input.calculation.hrdf
        patch.hrdfEnabled = hrdf.contribute
        // Turning HRDF off clears the rate so a later re-enable can't
        // silently inherit a stale percentage. Same rule as
        // PATCH /api/v1/payroll-settings.
        patch.hrdfRate = hrdf.contribute ? (hrdf.rate ?? null) : null
      }
      if (Object.keys(patch).length > 0) {
        await payrollSettingsRepository.upsert({ organizationId, patch })
      }
      applied.push("calculation")
    } catch (error) {
      fail("calculation", error, "Could not save payroll settings.")
    }
  }

  // ── overtime (fan-out) ──────────────────────────────────────────────
  if (input.overtime) {
    try {
      const otPatch = toPolicyOtPatch(input.overtime)
      if (Object.keys(otPatch).length === 0) {
        // An empty block is a no-op, not an error — the caller sent the
        // key with nothing in it.
        applied.push("overtime")
      } else {
        const policies = (
          await policyRepository.listForOrganization(organizationId)
        ).filter((p) => !p.archived)
        if (policies.length === 0) {
          // Provisioning seeds two policies, but the seeder is
          // best-effort (it warns and continues on failure), so an org
          // genuinely can have none.
          throw new Error(
            "This organization has no employee policy to write OT rates to. Create one via POST /api/v1/policies first.",
          )
        }
        for (const policy of policies) {
          await policyRepository.update({
            id: policy.id,
            organizationId,
            ...otPatch,
          })
          policiesUpdated.push(policy.id)
        }
        applied.push("overtime")
      }
    } catch (error) {
      // Deliberately NOT cleared: the loop writes policies one at a
      // time, so a failure on the third leaves the first two written.
      // Reporting an empty list would hide writes that really happened,
      // which defeats the point of returning the blast radius at all.
      fail("overtime", error, "Could not update OT rates.")
    }
  }

  // ── workSchedule ────────────────────────────────────────────────────
  if (input.workSchedule) {
    try {
      const ws = input.workSchedule
      const projects =
        await organizationRepository.getProjectsForOrganization(organizationId)

      let target = null as (typeof projects)[number] | null
      if (ws.projectId) {
        target = projects.find((p) => p.id === ws.projectId) ?? null
        if (!target) {
          throw new Error("Project not found in this organization.")
        }
      } else if (projects.length === 1) {
        target = projects[0] ?? null
      } else if (projects.length === 0) {
        throw new Error(
          "This organization has no project to write working hours to. Create one via POST /api/v1/projects first.",
        )
      } else {
        throw new Error(
          "This organization has more than one project — pass `workSchedule.projectId` to say which one these hours belong to.",
        )
      }

      if (target) {
        // `updateProjectCalendar` writes all three columns
        // unconditionally, so omitted keys have to be back-filled from
        // the current row — otherwise setting only the lunch break
        // would null the working hours.
        await organizationRepository.updateProjectCalendar(target.id, {
          workingHoursStart:
            ws.workingHoursStart !== undefined
              ? ws.workingHoursStart
              : (target.workingHoursStart ?? null),
          workingHoursEnd:
            ws.workingHoursEnd !== undefined
              ? ws.workingHoursEnd
              : (target.workingHoursEnd ?? null),
          workingDays: target.workingDays ?? null,
          ...(ws.lunchBreakMinutes !== undefined
            ? { lunchBreakMinutes: ws.lunchBreakMinutes }
            : {}),
        })
        projectUpdated = target.id
      }
      applied.push("workSchedule")
    } catch (error) {
      projectUpdated = null
      fail("workSchedule", error, "Could not update the project calendar.")
    }
  }

  // ── leave ───────────────────────────────────────────────────────────
  if (input.leave) {
    try {
      await applyLeaveDefaults(organizationId, input.leave, leaveTypesUpdated)
      applied.push("leave")
    } catch (error) {
      // `leaveTypesUpdated` keeps whatever was written before the
      // failure — same reasoning as the overtime loop above.
      fail("leave", error, "Could not update leave defaults.")
    }
  }

  return {
    applied,
    failed,
    policiesUpdated,
    projectUpdated,
    leaveTypesUpdated,
  }
}

/**
 * Resolve the working week from whichever of the two shapes the caller
 * sent. `nonWorkingDays` is the complement, stored in the same column —
 * it is NOT a second setting, which is why the route rejects a body
 * carrying both. Returns null when neither was sent (nothing to write).
 */
function resolveWorkingWeek(settings: {
  workingDays?: WeekdayName[]
  nonWorkingDays?: WeekdayName[]
}): WeekdayName[] | null {
  if (settings.workingDays !== undefined) return settings.workingDays
  if (settings.nonWorkingDays === undefined) return null

  const week = invertWeekdayNames(settings.nonWorkingDays)
  if (week.length === 0) {
    // An empty week would make the proration divisor zero.
    throw new Error(
      "`nonWorkingDays` cannot cover all 7 days — the org needs at least one working day.",
    )
  }
  return week
}

/** External `otRates` vocabulary to the repository's column names. */
function toPolicyOtPatch(
  overtime: NonNullable<OnboardingSetupInput["overtime"]>,
): Partial<PolicyOtRateInput> {
  const patch: Partial<PolicyOtRateInput> = {}
  if (overtime.normalDay !== undefined) {
    patch.otRateNormalDay = overtime.normalDay
  }
  if (overtime.restDay !== undefined) patch.otRateRestDay = overtime.restDay
  if (overtime.publicHoliday !== undefined) {
    patch.otRatePublicHoliday = overtime.publicHoliday
  }
  if (overtime.restDayInShift !== undefined) {
    patch.otRateRestDayInShift = overtime.restDayInShift
  }
  if (overtime.publicHolidayInShift !== undefined) {
    patch.otRatePublicHolidayInShift = overtime.publicHolidayInShift
  }
  if (overtime.salaryThreshold !== undefined) {
    patch.otSalaryThreshold = overtime.salaryThreshold
  }
  if (overtime.dailyThresholdMinutes !== undefined) {
    patch.otDailyThresholdMinutes = overtime.dailyThresholdMinutes
  }
  return patch
}

/**
 * Merge the `entitlements` and `carryForward` maps into ONE patch per
 * leave type, so a code appearing in both is a single write rather than
 * two. Returns the codes actually written.
 *
 * Rejection rules mirror `PATCH /api/v1/leave-types` verbatim — unknown
 * code, archived type, and a day count on unpaid leave — so the two
 * doors behave identically. Throws on the first problem, before any
 * write runs, so a bad code can't leave half the codes applied.
 */
async function applyLeaveDefaults(
  organizationId: string,
  leave: NonNullable<OnboardingSetupInput["leave"]>,
  /// Written codes are pushed here as they land, so a failure partway
  /// through still tells the caller what got through.
  written: string[],
): Promise<void> {
  const entitlements = leave.entitlements ?? {}
  const carryForward = leave.carryForward ?? {}

  const codes = Array.from(
    new Set(
      [...Object.keys(entitlements), ...Object.keys(carryForward)].map((c) =>
        c.toUpperCase(),
      ),
    ),
  )
  if (codes.length === 0) return

  // Include archived so we can tell "no such code" from "that one is
  // archived" — two different fixes for the caller.
  const allTypes = await leaveRepository.listTypes(organizationId, {
    includeArchived: true,
  })
  const byCode = new Map(allTypes.map((t) => [t.code.toUpperCase(), t]))

  const unknown = codes.filter((c) => !byCode.has(c))
  if (unknown.length > 0) {
    throw new Error(
      `Unknown leave type code(s): ${unknown.join(", ")}. Known codes: ${allTypes
        .map((t) => t.code)
        .join(", ")}. Creating new leave types isn't supported here.`,
    )
  }

  const archived = codes.filter((c) => byCode.get(c)?.archivedAt)
  if (archived.length > 0) {
    throw new Error(
      `Archived leave type(s): ${archived.join(", ")}. Restore them in AltomateHR before setting defaults.`,
    )
  }

  // Unpaid leave has no quota by design — `LeaveType.paid = false` makes
  // the engine ignore `defaultDays` entirely. Accepting a number here
  // would store a value that never applies.
  const unpaid = codes.filter(
    (c) => !byCode.get(c)?.paid && (entitlements[c] ?? 0) > 0,
  )
  if (unpaid.length > 0) {
    throw new Error(
      `${unpaid.join(", ")} is unpaid leave, which has no entitlement — the engine ignores its day count. Send 0 or omit it.`,
    )
  }

  for (const code of codes) {
    const type = byCode.get(code)
    if (!type) continue

    const patch: Parameters<typeof leaveRepository.updateType>[2] = {}
    const days = entitlements[code]
    if (days !== undefined) patch.defaultDays = days

    const cf = carryForward[code]
    if (cf !== undefined) {
      patch.carryForward = cf.enabled
      if (cf.enabled) {
        // `expiryMonth` is a MONTH OF YEAR (1-12) after which carried
        // days expire — not a duration. The route makes it mandatory
        // when enabling, so it is present here.
        if (cf.expiryMonth != null) patch.carryExpiryMonth = cf.expiryMonth
        if (cf.maxDays !== undefined) {
          patch.maxCarryForwardDays = cf.maxDays
        }
      }
      // Disabling leaves the expiry month and cap where they are. Unlike
      // a stale HRDF rate they cause nothing to happen on their own —
      // `carriedDays` simply never accumulates — so clearing them would
      // destroy the admin's configuration for no safety gain.
    }

    if (Object.keys(patch).length === 0) continue
    await leaveRepository.updateType(organizationId, type.id, patch)
    written.push(code)
  }
}
