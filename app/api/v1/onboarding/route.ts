import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import {
  bustLeaveCaches,
  bustOrgConfigCaches,
  bustPayrollCaches,
} from "@/lib/cache-invalidation"
import { weekdayNames } from "@/lib/weekdays"
import { applyOnboardingSetup } from "@/modules/organization/application/services/onboarding-setup.service"
import { calculationBlock, hhmm } from "../_shared/blocks"

/**
 * PUT /api/v1/onboarding — the payroll-policy answers from a partner's
 * client setup form, in one call.
 *
 * ## What this is for
 *
 * A setup form collects one company-wide answer per question. Our model
 * spreads those answers across four aggregates at three layers, and two
 * of them need ids the partner would otherwise have to look up first.
 * This route takes the flat body and resolves the layering here — most
 * importantly the OT fan-out, which applies to EVERY non-archived
 * policy rather than just the default. Left to documentation, that rule
 * gets missed and hourly staff quietly keep statutory rates.
 *
 * ## What this is NOT for
 *
 * Company identity and banking stay on
 * `PATCH /api/v1/payroll-settings` — registration numbers, the LHDN
 * profile and the payor account are a different concern with their own
 * validation, and folding them in here would mean two copies of it.
 * The seam is: **this route is payroll POLICY, payroll-settings is
 * company IDENTITY.**
 *
 * Ongoing edits are not this route's job either. `overtime` overwrites
 * every policy, which is right for a client stating one OT policy at
 * setup and wrong once CS has deliberately diverged a group. After
 * go-live use `PATCH /api/v1/policies/[id]` for one group and
 * `PATCH /api/v1/projects/[id]` for one site.
 *
 * ## Semantics
 *
 * PUT because re-sending the same body is the documented fix for a
 * partial failure. Every block is idempotent and there is no
 * surrounding transaction — same as every other write path in
 * `/api/v1`. Blocks apply in a fixed order (settings, calculation,
 * overtime, workSchedule, leave); a block that fails is reported in
 * `failed`
 * and the rest still run, so a wrong project id doesn't cost the caller
 * their OT rates.
 *
 * Status is 200 when every block applied, 409 when any block failed.
 * Read `applied` / `failed` either way — a 409 does NOT mean nothing
 * was written.
 *
 * ## Leave defaults, and why order matters
 *
 * The `leave` block writes `LeaveType` — the bottom of the three-level
 * entitlement chain. `ensureEntitlement` creates an employee's row
 * LAZILY on first access and snapshots `entitledDays` at that moment,
 * so this block is fully effective before staff start using the system
 * and progressively weaker afterwards. Send it before employees are
 * created, or at least before anyone opens the leave screen.
 *
 * Accrual method, first-year proration and per-policy overrides are
 * deliberately absent: they are judgment calls, not scalars a setup
 * form can answer. They stay with CS in the admin UI.
 *
 * Scopes: `settings:write` + `policies:write` + `projects:write` +
 * `leave:write`, all required (they're checked as an AND). Every
 * provisioned token holds the full catalogue, so no token needs
 * re-issuing.
 *
 * Gate on the `onboarding.bulk` feature flag from `GET /whoami` before
 * sending — this schema is `.strict()` like its neighbours.
 */

/**
 * OT bounds deliberately match `POST`/`PATCH /api/v1/policies` rather
 * than the tighter ones on the retired `PATCH /api/v1/settings
 * { otRates }`. These write the same columns as the policies route, so
 * a value accepted there has to be accepted here — one behaviour per
 * column, whichever door the caller comes through.
 */
const overtimeBlock = z
  .object({
    normalDay: z.number().nonnegative().optional(),
    restDay: z.number().nonnegative().optional(),
    publicHoliday: z.number().nonnegative().optional(),
    restDayInShift: z.number().nonnegative().optional(),
    publicHolidayInShift: z.number().nonnegative().optional(),
    salaryThreshold: z.number().nonnegative().nullable().optional(),
    /// "Normal hours per day" x 60. Minutes rather than hours because
    /// that's what `GET /api/v1/policies` already reports as
    /// `otRates.dailyThresholdMinutes` — what you read is what you send.
    dailyThresholdMinutes: z.number().int().nonnegative().optional(),
  })
  .strict()

/**
 * Org-wide leave defaults, keyed by the seeded leave-type CODE
 * (`ANNUAL`, `MEDICAL`, `HOSPITALIZATION`, `MATERNITY`, `PATERNITY`,
 * `COMPASSIONATE`, `MARRIAGE`, `UNPAID`), matched case-insensitively —
 * same keying as `PATCH /api/v1/leave-types`, which writes the
 * `entitlements` half of this on its own.
 *
 * There is no create path: a ninth leave type is a CS conversation.
 */
const leaveBlock = z
  .object({
    /// Day count per code. Half-days are allowed. Sending a non-zero
    /// count for UNPAID is rejected — the engine ignores it.
    entitlements: z
      .record(z.string().trim().min(1), z.number().min(0).max(365))
      .optional(),
    /// Carry-forward per code.
    ///
    /// `expiryMonth` is a MONTH OF YEAR (1-12) after which carried days
    /// expire — NOT a number of months after rollover. "Carried days
    /// last until the end of March" is `3`. Mandatory when enabling,
    /// because carry-forward with no expiry never releases the days.
    carryForward: z
      .record(
        z.string().trim().min(1),
        z
          .object({
            enabled: z.boolean(),
            expiryMonth: z.number().int().min(1).max(12).nullable().optional(),
            /// Cap on carried days at rollover. `null` = uncapped.
            maxDays: z.number().min(0).max(365).nullable().optional(),
          })
          .strict()
          .refine((v) => !v.enabled || v.expiryMonth != null, {
            message:
              "expiryMonth is required when enabled is true — it is the month of year (1-12) after which carried days expire.",
            path: ["expiryMonth"],
          }),
      )
      .optional(),
  })
  .strict()

const onboardingSchema = z
  .object({
    /// Org-wide working week. Send exactly one of the two — they write
    /// the same column, so sending both is a 400 rather than a silent
    /// precedence rule.
    settings: z
      .object({
        workingDays: z.array(z.enum(weekdayNames)).min(1).max(7).optional(),
        nonWorkingDays: z.array(z.enum(weekdayNames)).max(6).optional(),
      })
      .strict()
      .optional(),
    calculation: calculationBlock.optional(),
    overtime: overtimeBlock.optional(),
    /// Working hours for the org's project. `projectId` is only needed
    /// when the org has more than one project; with exactly one we use
    /// it. Working DAYS are not accepted here — `settings.workingDays`
    /// is the org-wide answer.
    workSchedule: z
      .object({
        projectId: z.string().min(1).optional(),
        workingHoursStart: hhmm.nullable().optional(),
        workingHoursEnd: hhmm.nullable().optional(),
        lunchBreakMinutes: z.number().int().min(0).max(240).optional(),
      })
      .strict()
      .optional(),
    leave: leaveBlock.optional(),
  })
  .strict()

export const PUT = handleApiRequest(
  ["settings:write", "policies:write", "projects:write", "leave:write"],
  async (request, ctx) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = onboardingSchema.safeParse(body)
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

    if (
      parsed.data.settings?.workingDays !== undefined &&
      parsed.data.settings?.nonWorkingDays !== undefined
    ) {
      return jsonError(
        400,
        "Send either `settings.workingDays` or `settings.nonWorkingDays`, not both — they write the same column.",
      )
    }

    const organizationId = ctx.integration.organizationId
    const result = await applyOnboardingSetup({
      organizationId,
      input: parsed.data,
    })

    if (result.applied.length > 0) {
      // Over-invalidate on purpose: `calculation` lands on payroll
      // page-data and the rest on org config, and a setup call is rare
      // enough that splitting the two buys nothing.
      await Promise.all([
        bustOrgConfigCaches({ organizationId }),
        bustPayrollCaches({ organizationId }),
        bustLeaveCaches({ organizationId }),
      ])
    }

    return NextResponse.json(
      { data: result },
      { status: result.failed.length > 0 ? 409 : 200 },
    )
  },
)

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
