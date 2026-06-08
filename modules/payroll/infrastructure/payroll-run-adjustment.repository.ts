import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { toNumber } from "@/lib/decimal"
import type {
  FixedAllowanceOverrideMap,
  ManualLineItem,
  PayrollRunAdjustmentData,
} from "@/modules/payroll/domain/runs"

/**
 * Prisma-side repository for `PayrollRunAdjustment`. One row per
 * (run, employee). Survives payslip regeneration — payslips are
 * recreated from these on each "Generate" press.
 */
export const payrollRunAdjustmentRepository = {
  /**
   * List every adjustment for a run, keyed by `employeeProfileId` for
   * O(1) lookup in the calc loop.
   */
  async listForRun(
    payrollRunId: string,
  ): Promise<Map<string, PayrollRunAdjustmentData>> {
    const prisma = getPrismaClient()
    if (!prisma) return new Map()

    const rows = await prisma.payrollRunAdjustment.findMany({
      where: { payrollRunId },
    })
    const out = new Map<string, PayrollRunAdjustmentData>()
    for (const r of rows) {
      out.set(r.employeeProfileId, mapAdjustment(r))
    }
    return out
  },

  /**
   * Fetch a single adjustment row by (run, employee). Returns null
   * when the admin hasn't filled in anything yet — the UI shows an
   * empty form in that case.
   */
  async getOne(input: {
    payrollRunId: string
    employeeProfileId: string
  }): Promise<PayrollRunAdjustmentData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.payrollRunAdjustment.findUnique({
      where: {
        payrollRunId_employeeProfileId: {
          payrollRunId: input.payrollRunId,
          employeeProfileId: input.employeeProfileId,
        },
      },
    })
    if (!row) return null
    return mapAdjustment(row)
  },

  /**
   * Upsert by (run, employee). Patches the supplied fields; anything
   * undefined is left untouched. Pass an empty `manualLineItems`
   * array to clear all manual lines.
   */
  async upsert(input: {
    payrollRunId: string
    employeeProfileId: string
    patch: Partial<{
      otNormalHours: number
      otRestHours: number
      otPublicHours: number
      workedHours: number | null
      expectedHours: number | null
      manualLineItems: ManualLineItem[]
      fixedAllowanceOverrides: FixedAllowanceOverrideMap
      notes: string | null
    }>
  }): Promise<PayrollRunAdjustmentData> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const data = toUpsertData(input.patch)

    const row = await prisma.payrollRunAdjustment.upsert({
      where: {
        payrollRunId_employeeProfileId: {
          payrollRunId: input.payrollRunId,
          employeeProfileId: input.employeeProfileId,
        },
      },
      create: {
        payrollRunId: input.payrollRunId,
        employeeProfileId: input.employeeProfileId,
        manualLineItems: [],
        fixedAllowanceOverrides: [],
        ...data,
      },
      update: data,
    })

    return mapAdjustment(row)
  },

  /**
   * Delete an adjustment row. Used when an admin clears everything
   * for an employee.
   */
  async deleteOne(input: {
    payrollRunId: string
    employeeProfileId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    await prisma.payrollRunAdjustment.deleteMany({
      where: {
        payrollRunId: input.payrollRunId,
        employeeProfileId: input.employeeProfileId,
      },
    })
  },
}

// ─── Projection helpers ──────────────────────────────────────────────────

function mapAdjustment(row: any): PayrollRunAdjustmentData {
  return {
    id: row.id,
    payrollRunId: row.payrollRunId,
    employeeProfileId: row.employeeProfileId,
    otNormalHours: toNumber(row.otNormalHours, 0),
    otRestHours: toNumber(row.otRestHours, 0),
    otPublicHours: toNumber(row.otPublicHours, 0),
    workedHours: row.workedHours == null ? null : toNumber(row.workedHours, 0),
    expectedHours:
      row.expectedHours == null ? null : toNumber(row.expectedHours, 0),
    manualLineItems: parseManualLineItems(row.manualLineItems),
    fixedAllowanceOverrides: parseFixedAllowanceOverrides(
      row.fixedAllowanceOverrides,
    ),
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Parse the `fixedAllowanceOverrides` JSON column. Defensive — rows
 * with non-numeric amounts or weird shapes are dropped silently so a
 * bad migration can't crash the calc engine.
 */
function parseFixedAllowanceOverrides(
  value: unknown,
): FixedAllowanceOverrideMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: FixedAllowanceOverrideMap = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const skip = r.skip === true
    let amount: number | null = null
    if (typeof r.amount === "number" && Number.isFinite(r.amount)) {
      amount = r.amount
    } else if (typeof r.amount === "string") {
      const n = Number(r.amount)
      if (Number.isFinite(n)) amount = n
    }
    // Skip rows with no signal at all — that's the same as no override.
    if (!skip && amount === null) continue
    out[key] = { amount, skip }
  }
  return out
}

function parseManualLineItems(value: unknown): ManualLineItem[] {
  if (!Array.isArray(value)) return []
  const out: ManualLineItem[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const i = item as Record<string, unknown>
    const kind: ManualLineItem["kind"] =
      i.kind === "DEDUCTION"
        ? "DEDUCTION"
        : i.kind === "REIMBURSEMENT"
          ? "REIMBURSEMENT"
          : "ALLOWANCE"
    // Pre-Phase-19 rows have no `category`. Default by kind so the
    // calc engine still finds a valid meta entry.
    const categoryRaw = typeof i.category === "string" ? i.category : null
    const defaultCategory =
      kind === "DEDUCTION"
        ? "deduct_salary_adjustment"
        : kind === "REIMBURSEMENT"
          ? "wages_expense_claim"
          : "allowance_standard"
    const category =
      categoryRaw && categoryRaw.length > 0 ? categoryRaw : defaultCategory
    const defaultLabel =
      kind === "DEDUCTION"
        ? "Deduction"
        : kind === "REIMBURSEMENT"
          ? "Expense claim"
          : "Allowance"
    const label =
      typeof i.label === "string" && i.label.trim().length > 0
        ? i.label
        : defaultLabel
    const amountRaw = i.amount
    const amount =
      typeof amountRaw === "number"
        ? amountRaw
        : typeof amountRaw === "string"
          ? Number(amountRaw)
          : 0
    if (!Number.isFinite(amount) || amount <= 0) continue
    // Preserve the optional sourceEntitlementId backlink — set by the
    // leave-cash-out attach flow so detach can find the row without
    // label matching. Other line items have it undefined.
    const sourceEntitlementId =
      typeof i.sourceEntitlementId === "string" && i.sourceEntitlementId.length > 0
        ? i.sourceEntitlementId
        : undefined
    // Preserve the LHDN AR override flag — see `ManualLineItem.treatAsRecurring`
    // in `domain/runs.ts`. Defaults to undefined → AR formula stays
    // the default for bonus/commission/etc., matching pre-flag behaviour.
    const treatAsRecurring = i.treatAsRecurring === true ? true : undefined
    out.push({
      kind,
      category,
      label,
      amount,
      ...(sourceEntitlementId ? { sourceEntitlementId } : {}),
      ...(treatAsRecurring ? { treatAsRecurring } : {}),
    })
  }
  return out
}

function toUpsertData(
  patch: Parameters<
    typeof payrollRunAdjustmentRepository.upsert
  >[0]["patch"],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (patch.otNormalHours !== undefined) out.otNormalHours = patch.otNormalHours
  if (patch.otRestHours !== undefined) out.otRestHours = patch.otRestHours
  if (patch.otPublicHours !== undefined) out.otPublicHours = patch.otPublicHours
  if (patch.workedHours !== undefined) out.workedHours = patch.workedHours
  if (patch.expectedHours !== undefined) out.expectedHours = patch.expectedHours
  if (patch.manualLineItems !== undefined) {
    out.manualLineItems = patch.manualLineItems as unknown as object
  }
  if (patch.fixedAllowanceOverrides !== undefined) {
    out.fixedAllowanceOverrides =
      patch.fixedAllowanceOverrides as unknown as object
  }
  if (patch.notes !== undefined) out.notes = patch.notes
  return out
}
