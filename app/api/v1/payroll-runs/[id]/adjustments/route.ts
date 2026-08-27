import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { safeErrorMessage } from "@/lib/errors"
import {
  payrollAdjustmentCategories,
  PAYROLL_ADJUSTMENT_CATEGORY_META,
} from "@/modules/payroll/domain/models"
import { manualLineItemKinds } from "@/modules/payroll/domain/runs"
import { payrollRunAdjustmentRepository } from "@/modules/payroll/infrastructure/payroll-run-adjustment.repository"
import {
  previewEmployeeNetForRunInOrg,
  savePayrollAdjustmentInOrg,
  type PayslipPreviewTotals,
} from "@/modules/payroll/application/services/payroll-run.service"

type RouteParams = { id: string }

/**
 * POST /api/v1/payroll-runs/[id]/adjustments — add a one-off line item
 * to one employee on a DRAFT run.
 *
 * ## The category is the dangerous field, not the amount
 *
 * "Add a bonus of RM4,000" does not identify a payroll item. Annual
 * Bonus is EPF-subject but not SOCSO/EIS-subject; Non-Annual Bonus is
 * subject to all three. Same word, different PERKESO contributions on
 * both sides, flowing into statutory filings. So `category` is
 * **required with no default** — a caller that doesn't know which one
 * the client meant has to ask a human rather than fall back to
 * `allowance_standard`, which would book a bonus as a recurring
 * allowance and tax it by the wrong method (projected across the year
 * instead of as Additional Remuneration).
 *
 * The accepted values are derived from `payrollAdjustmentCategories`,
 * so a category added to that constant works here the day it ships. Read
 * the list and its statutory flags from
 * `GET /api/v1/payroll/adjustment-categories`.
 *
 * ## `dryRun` is the point, not a convenience
 *
 * The response always includes `before`, `after` and `delta` for gross,
 * net, EPF (both sides), SOCSO, EIS and PCB — computed by the same calc
 * engine that generates the payslip. With `dryRun: true` nothing is
 * written, so a caller can put the CONSEQUENCE in front of a person and
 * have them confirm that, rather than confirming a sentence. A
 * confirmation that showed only the amount would hide exactly the
 * mistake the category question exists to prevent.
 *
 * ## Scope of the write
 *
 * Appends to the employee's `manualLineItems` — it does not replace
 * them. Repeat calls stack, which is what "add a bonus" means; there is
 * no dedupe, so a retried call adds a second line. Check `lineItemCount`
 * in the response rather than retrying blind.
 *
 * DRAFT runs only. A submitted run 409s — reverting it to draft is a
 * deliberate human act in AltomateHR, not something an API caller
 * should be able to route around.
 *
 * Scope: `payroll:write`.
 */
const bodySchema = z
  .object({
    /// EmployeeProfile id — NOT the User id. Resolve it from
    /// `employeeProfileId` on the employees resource before calling;
    /// the wrong id here would put money on the wrong person.
    employeeProfileId: z.string().trim().min(1),
    kind: z.enum(manualLineItemKinds),
    /// Required, no default. Derived from the domain constant so new
    /// categories need no change here.
    category: z.enum(payrollAdjustmentCategories),
    label: z.string().trim().min(1).max(120),
    amount: z.number().positive("amount must be greater than 0."),
    /// LHDN Additional Remuneration override. Only meaningful for
    /// AR-flagged categories (bonus / commission / arrears / gratuity /
    /// director fee). Set true when the employee receives this EVERY
    /// month — the default AR formula assumes a one-off and makes PCB
    /// swing wildly for recurring payments.
    treatAsRecurring: z.boolean().optional(),
    /// Compute and return the effect without writing anything.
    dryRun: z.boolean().optional(),
  })
  .strict()

export const POST = handleApiRequest<RouteParams>(
  ["payroll:write"],
  async (request, ctx) => {
    const { id: runId } = ctx.params
    if (!runId) return jsonError(400, "Missing payroll run id.")

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return jsonError(400, "Invalid JSON body.")
    }

    const parsed = bodySchema.safeParse(body)
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
    const d = parsed.data
    const organizationId = ctx.integration.organizationId

    // The category decides statutory treatment; surface it in the
    // response so the caller can show WHY the numbers moved.
    const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[d.category]
    if (meta.kind !== d.kind) {
      return jsonError(
        400,
        `Category "${d.category}" is a ${meta.kind} item but kind was "${d.kind}". Send kind "${meta.kind}", or pick a category of the kind you meant.`,
      )
    }

    // Existing row first: manual line items STACK, so a preview that
    // ignored what's already there would understate the result.
    const existing = await payrollRunAdjustmentRepository.getOne({
      payrollRunId: runId,
      employeeProfileId: d.employeeProfileId,
    })
    const currentLines = existing?.manualLineItems ?? []
    const newLine = {
      kind: d.kind,
      category: d.category,
      label: d.label,
      amount: d.amount,
      ...(d.treatAsRecurring !== undefined
        ? { treatAsRecurring: d.treatAsRecurring }
        : {}),
    }
    const nextLines = [...currentLines, newLine]

    const basePatch = {
      otNormalHours: existing?.otNormalHours ?? 0,
      otRestHours: existing?.otRestHours ?? 0,
      otPublicHours: existing?.otPublicHours ?? 0,
      workedHours: existing?.workedHours ?? null,
      expectedHours: existing?.expectedHours ?? null,
      fixedAllowanceOverrides: existing?.fixedAllowanceOverrides ?? {},
    }

    const [before, after] = await Promise.all([
      previewEmployeeNetForRunInOrg({
        runId,
        employeeProfileId: d.employeeProfileId,
        organizationId,
        patch: { ...basePatch, manualLineItems: currentLines },
      }),
      previewEmployeeNetForRunInOrg({
        runId,
        employeeProfileId: d.employeeProfileId,
        organizationId,
        patch: { ...basePatch, manualLineItems: nextLines },
      }),
    ])

    if (!before || !after) {
      // Null means the run or employee couldn't be resolved in this org.
      // Never treat that as "no change" — it means we didn't compute.
      return jsonError(
        404,
        "Payroll run or employee not found in this organization.",
      )
    }

    const effect = {
      category: d.category,
      categoryLabel: meta.label,
      statutory: {
        subjectToEpf: meta.subjectToEpf,
        subjectToSocso: meta.subjectToSocso,
        subjectToEis: meta.subjectToEis,
        subjectToPcb: meta.subjectToPcb,
        subjectToHrdf: meta.subjectToHrdf,
      },
      before,
      after,
      delta: diff(before, after),
    }

    if (d.dryRun) {
      return NextResponse.json({
        data: { applied: false, lineItemCount: nextLines.length, ...effect },
      })
    }

    try {
      const saved = await savePayrollAdjustmentInOrg({
        runId,
        employeeProfileId: d.employeeProfileId,
        organizationId,
        patch: { manualLineItems: nextLines },
      })
      return NextResponse.json(
        {
          data: {
            applied: true,
            lineItemCount: saved.manualLineItems.length,
            ...effect,
          },
        },
        { status: 201 },
      )
    } catch (error) {
      // The DRAFT guard and the not-found case both surface here.
      const message = safeErrorMessage(error, "Could not save the adjustment.")
      return jsonError(/submitted/i.test(message) ? 409 : 400, message)
    }
  },
)

function diff(
  before: PayslipPreviewTotals,
  after: PayslipPreviewTotals,
): PayslipPreviewTotals {
  const round2 = (n: number) => Math.round(n * 100) / 100
  return {
    grossPay: round2(after.grossPay - before.grossPay),
    netPay: round2(after.netPay - before.netPay),
    epfEmployee: round2(after.epfEmployee - before.epfEmployee),
    epfEmployer: round2(after.epfEmployer - before.epfEmployer),
    socsoEmployee: round2(after.socsoEmployee - before.socsoEmployee),
    socsoEmployer: round2(after.socsoEmployer - before.socsoEmployer),
    eisEmployee: round2(after.eisEmployee - before.eisEmployee),
    eisEmployer: round2(after.eisEmployer - before.eisEmployer),
    pcb: round2(after.pcb - before.pcb),
  }
}

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}
