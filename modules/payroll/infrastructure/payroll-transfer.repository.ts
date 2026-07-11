import "server-only"

import type { EmployeeTransferStatus } from "@/generated/prisma/enums"
import { getPrismaClient } from "@/lib/prisma"

/**
 * Repository for `EmployeeTransfer` — the queue of scheduled + historical
 * cross-company transfers. See the model docblock in schema.prisma for
 * the full semantic explanation.
 *
 * Only structural persistence lives here. All the multi-table logic
 * (archive source / create target profile / copy YTD) sits in the
 * service alongside the required auth checks — this repo just
 * reads/writes the queue row itself.
 */

export type EmployeeTransferRow = {
  id: string
  sourceEmployeeProfileId: string
  sourceOrganizationId: string
  targetOrganizationId: string
  targetPolicyId: string
  createdByUserId: string
  effectiveDate: string
  copyPayrollInfo: boolean
  notes: string | null
  status: EmployeeTransferStatus
  createdAt: string
  executedAt: string | null
  errorMessage: string | null
}

export type PendingTransferRow = EmployeeTransferRow & {
  employeeName: string
  employeeIdCode: string
  targetOrganizationName: string
}

export const payrollTransferRepository = {
  /**
   * Insert a new PENDING row. Callers are expected to have already
   * validated admin access + target/source constraints — this method
   * just persists.
   */
  async create(input: {
    sourceEmployeeProfileId: string
    sourceOrganizationId: string
    targetOrganizationId: string
    targetPolicyId: string
    createdByUserId: string
    effectiveDate: Date
    copyPayrollInfo: boolean
    notes: string | null
  }): Promise<EmployeeTransferRow> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const row = await prisma.employeeTransfer.create({
      data: {
        sourceEmployeeProfileId: input.sourceEmployeeProfileId,
        sourceOrganizationId: input.sourceOrganizationId,
        targetOrganizationId: input.targetOrganizationId,
        targetPolicyId: input.targetPolicyId,
        createdByUserId: input.createdByUserId,
        effectiveDate: input.effectiveDate,
        copyPayrollInfo: input.copyPayrollInfo,
        notes: input.notes,
      },
    })
    return mapRow(row)
  },

  async getById(id: string): Promise<EmployeeTransferRow | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.employeeTransfer.findUnique({ where: { id } })
    return row ? mapRow(row) : null
  },

  /**
   * Look up any PENDING row for the given source profile. Used to
   * refuse a second pending transfer while one is already queued and
   * to populate the "already-pending" banner on the employee detail
   * page.
   */
  async findPendingBySource(
    sourceEmployeeProfileId: string,
  ): Promise<EmployeeTransferRow | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.employeeTransfer.findFirst({
      where: {
        sourceEmployeeProfileId,
        status: "PENDING",
      },
    })
    return row ? mapRow(row) : null
  },

  /**
   * Mark a PENDING row as CANCELLED. No-op when the row is already
   * EXECUTED / CANCELLED / FAILED — the admin can create a new one.
   */
  async cancel(id: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.employeeTransfer.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "CANCELLED" },
    })
  },

  /**
   * Mark EXECUTED with the current timestamp. Called by the service
   * inside the same transaction that does the actual work.
   */
  async markExecuted(id: string, tx?: unknown): Promise<void> {
    const client = (tx as ReturnType<typeof getPrismaClient>) ?? getPrismaClient()
    if (!client) throw new Error("Database is not configured.")
    await client.employeeTransfer.update({
      where: { id },
      data: { status: "EXECUTED", executedAt: new Date(), errorMessage: null },
    })
  },

  /**
   * Mark FAILED with an error message so the operator can diagnose.
   * Cron will retry until it moves to EXECUTED or is manually
   * cancelled — record the message on each attempt.
   */
  async markFailed(id: string, message: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return
    await prisma.employeeTransfer.update({
      where: { id },
      data: { status: "FAILED", errorMessage: message.slice(0, 500) },
    })
  },

  /**
   * List every PENDING or FAILED transfer whose effectiveDate has
   * arrived — the cron sweep target. Failed rows are included so a
   * transient issue (e.g. brief DB blip) auto-retries the next day
   * without manual intervention.
   */
  async listDueForExecution(now: Date): Promise<EmployeeTransferRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.employeeTransfer.findMany({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        effectiveDate: { lte: now },
      },
      orderBy: { effectiveDate: "asc" },
    })
    return rows.map(mapRow)
  },

  /**
   * List every PENDING transfer whose source is in the given org.
   * Used by the Manage Employee list to render a "pending transfer"
   * badge next to affected employees.
   */
  async listPendingForOrg(
    organizationId: string,
  ): Promise<PendingTransferRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.employeeTransfer.findMany({
      where: { sourceOrganizationId: organizationId, status: "PENDING" },
      include: {
        sourceEmployeeProfile: {
          select: {
            employeeId: true,
            user: { select: { name: true } },
          },
        },
        targetOrganization: { select: { name: true } },
      },
      orderBy: { effectiveDate: "asc" },
    })
    return rows.map((r) => ({
      ...mapRow(r),
      employeeName: r.sourceEmployeeProfile.user.name ?? "(no name)",
      employeeIdCode: r.sourceEmployeeProfile.employeeId,
      targetOrganizationName: r.targetOrganization.name,
    }))
  },
}

// ─── Internals ─────────────────────────────────────────────────────

function mapRow(row: {
  id: string
  sourceEmployeeProfileId: string
  sourceOrganizationId: string
  targetOrganizationId: string
  targetPolicyId: string
  createdByUserId: string
  effectiveDate: Date
  copyPayrollInfo: boolean
  notes: string | null
  status: EmployeeTransferStatus
  createdAt: Date
  executedAt: Date | null
  errorMessage: string | null
}): EmployeeTransferRow {
  return {
    id: row.id,
    sourceEmployeeProfileId: row.sourceEmployeeProfileId,
    sourceOrganizationId: row.sourceOrganizationId,
    targetOrganizationId: row.targetOrganizationId,
    targetPolicyId: row.targetPolicyId,
    createdByUserId: row.createdByUserId,
    effectiveDate: row.effectiveDate.toISOString().slice(0, 10),
    copyPayrollInfo: row.copyPayrollInfo,
    notes: row.notes,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    executedAt: row.executedAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
  }
}
