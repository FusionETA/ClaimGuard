import { z } from "zod"

/**
 * Zod fragments shared by more than one /api/v1 route.
 *
 * These live here for ONE reason: `PUT /api/v1/onboarding` writes the
 * same fields as `PATCH /api/v1/payroll-settings` and
 * `PATCH /api/v1/projects/[id]`, and two independent copies of a
 * validation rule drift the first time one side gains a field or
 * loosens a bound. Anything used by exactly one route stays in that
 * route — this file is not a dumping ground for "reusable" schemas.
 *
 * `_shared` is a Next.js private folder (leading `_`), so nothing here
 * is routable.
 */

/**
 * 24-hour `HH:MM`. Shared by the project calendar on
 * `PATCH /api/v1/projects/[id]` and `PUT /api/v1/onboarding`.
 */
export const hhmm = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM in 24-hour form.")

/**
 * The payroll `calculation` block — the two rules that ARE
 * configurable per org.
 *
 * Explicitly fixed engine behaviour — do not add these as choices, we
 * cannot honour them:
 *   - unpaid-leave basis: always the same basis as `prorationBasis`
 *     (the deduction is `monthlySalary / workingDaysForPeriod(basis)`),
 *     never independently selectable.
 *   - recording unpaid leave in payroll: always on. Approved unpaid
 *     leave always produces a `deduct_unpaid_leave` line.
 *   - adjusting salary by join date: always on. Proration by
 *     join/leave date is unconditional.
 *
 * `prorationBasis` maps to `PayrollSettings.workingDaysRule`. There is
 * no `ACTUAL_WORKING_DAYS` equivalent. `TWENTY_SIX` is a hybrid for
 * partial months: it counts the configured working weekdays in the
 * partial range, then caps the result at 26 — so the working week
 * feeds proration too.
 */
export const calculationBlock = z
  .object({
    prorationBasis: z.enum(["TWENTY_SIX", "CALENDAR"]).optional(),
    /// HRD Corp levy. Applied to Malaysian citizens only (PSMB Act
    /// s 2), on the prorated pay plus HRDF-subject allowances.
    hrdf: z
      .object({
        contribute: z.boolean(),
        /// Percent, e.g. `1.0` for a registered employer under Part I
        /// or `0.5` under Part II. Required whenever `contribute` is
        /// true: the engine treats a null rate as 0%, which would
        /// silently levy nothing rather than fail.
        rate: z.number().min(0).max(100).nullable().optional(),
      })
      .strict()
      .refine((v) => !v.contribute || (v.rate != null && v.rate > 0), {
        message:
          "hrdf.rate must be greater than 0 when hrdf.contribute is true — a null or zero rate silently levies nothing.",
        path: ["rate"],
      })
      .optional(),
  })
  .strict()

export type CalculationBlock = z.infer<typeof calculationBlock>
