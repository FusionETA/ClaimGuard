import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { toNumber } from "@/lib/decimal"
import type {
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
      manualLineItems: ManualLineItem[]
      unpaidLeaveDeduction: number
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
    manualLineItems: parseManualLineItems(row.manualLineItems),
    unpaidLeaveDeduction: toNumber(row.unpaidLeaveDeduction, 0),
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function parseManualLineItems(value: unknown): ManualLineItem[] {
  if (!Array.isArray(value)) return []
  const out: ManualLineItem[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const i = item as Record<string, unknown>
    const kind = i.kind === "DEDUCTION" ? "DEDUCTION" : "ALLOWANCE"
    const label =
      typeof i.label === "string" && i.label.trim().length > 0
        ? i.label
        : kind === "DEDUCTION"
          ? "Deduction"
          : "Allowance"
    const amountRaw = i.amount
    const amount =
      typeof amountRaw === "number"
        ? amountRaw
        : typeof amountRaw === "string"
          ? Number(amountRaw)
          : 0
    if (!Number.isFinite(amount) || amount <= 0) continue
    out.push({ kind, label, amount })
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
  if (patch.manualLineItems !== undefined) {
    out.manualLineItems = patch.manualLineItems as unknown as object
  }
  if (patch.unpaidLeaveDeduction !== undefined) {
    out.unpaidLeaveDeduction = patch.unpaidLeaveDeduction
  }
  if (patch.notes !== undefined) out.notes = patch.notes
  return out
}
