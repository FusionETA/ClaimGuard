import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { toNumber } from "@/lib/decimal"
import type {
  AttachableClaimRow,
  PayrollRunClaimForCalc,
  PayrollRunClaimRow,
} from "@/modules/payroll/domain/runs"
import { periodLabel } from "@/modules/payroll/domain/runs"

/**
 * Prisma-side repository for `PayrollRunClaim`. This is the
 * source-of-truth join row connecting an APPROVED + SYNCED + PERSONAL
 * claim to a payroll run.
 *
 * Per-aggregate Prisma access rule applies — all `payrollRunClaim`
 * queries go through this file.
 */
export const payrollRunClaimRepository = {
  /**
   * List the attachments for one run, joined with claim + employee
   * identity so the UI can render rows without follow-up queries.
   */
  async listForRun(payrollRunId: string): Promise<PayrollRunClaimRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.payrollRunClaim.findMany({
      where: { payrollRunId },
      orderBy: { createdAt: "asc" },
      include: {
        claim: {
          select: {
            claimNumber: true,
            category: true,
            claimType: true,
          },
        },
        employeeProfile: {
          select: {
            employeeId: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
    })

    return rows.map((r) => ({
      id: r.id,
      payrollRunId: r.payrollRunId,
      claimId: r.claimId,
      employeeProfileId: r.employeeProfileId,
      userId: r.employeeProfile.user.id,
      label: r.label,
      amount: toNumber(r.amount, 0),
      employeeName: r.employeeProfile.user.name,
      employeeCode: r.employeeProfile.employeeId,
      claimNumber: r.claim.claimNumber,
      claimCategory: r.claim.category,
      claimType: r.claim.claimType,
      createdAt: r.createdAt.toISOString(),
    }))
  },

  /**
   * Compact list for the calc engine — fetches just the fields needed
   * to inflate REIMBURSEMENT line items, grouped per employee at the
   * service layer.
   */
  async listForCalc(payrollRunId: string): Promise<PayrollRunClaimForCalc[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.payrollRunClaim.findMany({
      where: { payrollRunId },
      select: {
        claimId: true,
        employeeProfileId: true,
        label: true,
        amount: true,
      },
    })

    return rows.map((r) => ({
      claimId: r.claimId,
      employeeProfileId: r.employeeProfileId,
      label: r.label,
      amount: toNumber(r.amount, 0),
    }))
  },

  /**
   * Attach a claim to a run. Verifies the claim isn't already on
   * another run (the @unique on claimId would fail otherwise) and
   * snapshots `label` + `amount`.
   *
   * Throws on:
   *   - claim already attached
   *   - run / claim cross-org mismatch (verified at the service layer)
   */
  async attach(input: {
    payrollRunId: string
    claimId: string
    employeeProfileId: string
    label: string
    amount: number
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    await prisma.payrollRunClaim.create({
      data: {
        payrollRunId: input.payrollRunId,
        claimId: input.claimId,
        employeeProfileId: input.employeeProfileId,
        label: input.label,
        amount: input.amount,
      },
    })
  },

  /**
   * Detach a claim from whatever run it's attached to. No-op if it
   * wasn't attached anywhere.
   */
  async detach(input: { claimId: string }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    await prisma.payrollRunClaim.deleteMany({
      where: { claimId: input.claimId },
    })
  },

  /**
   * List every claim in the org that's eligible to attach to a
   * payroll run: status REVIEWED, xeroSyncStatus SYNCED, paymentType
   * PERSONAL. Includes claims already attached to ANY run so the UI
   * can show "attached to <Month>" badges.
   *
   * `excludeAttached: true` strips out already-attached rows — useful
   * for the run detail picker so admins only see fresh candidates.
   */
  async listAttachableForOrg(input: {
    organizationId: string
    excludeAttached?: boolean
  }): Promise<AttachableClaimRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.claim.findMany({
      where: {
        organizationId: input.organizationId,
        status: "REVIEWED",
        xeroSyncStatus: "SYNCED",
        paymentType: "PERSONAL",
        ...(input.excludeAttached
          ? { payrollRunAttachment: { is: null } }
          : {}),
      },
      orderBy: { spentAt: "desc" },
      select: {
        id: true,
        claimNumber: true,
        title: true,
        category: true,
        claimType: true,
        amount: true,
        spentAt: true,
        employee: {
          select: {
            id: true,
            name: true,
            employeeProfile: {
              select: { id: true, employeeId: true },
            },
          },
        },
        payrollRunAttachment: {
          select: {
            payrollRunId: true,
            payrollRun: {
              select: { periodYear: true, periodMonth: true },
            },
          },
        },
      },
    })

    const result: AttachableClaimRow[] = []
    for (const r of rows) {
      const ep = r.employee.employeeProfile
      if (!ep) continue // claim author needs an EmployeeProfile
      result.push({
        claimId: r.id,
        claimNumber: r.claimNumber,
        title: r.title,
        category: r.category,
        claimType: r.claimType,
        amount: toNumber(r.amount, 0),
        spentAt: r.spentAt.toISOString(),
        employeeProfileId: ep.id,
        userId: r.employee.id,
        employeeName: r.employee.name,
        employeeCode: ep.employeeId,
        attachedToRunId: r.payrollRunAttachment?.payrollRunId ?? null,
        attachedToRunPeriod: r.payrollRunAttachment
          ? periodLabel(
              r.payrollRunAttachment.payrollRun.periodYear,
              r.payrollRunAttachment.payrollRun.periodMonth,
            )
          : null,
      })
    }
    return result
  },

  /**
   * Fetch a single claim + its EmployeeProfile (for attach validation
   * at the service layer). Returns null on cross-org mismatch.
   */
  async getClaimForAttach(input: {
    claimId: string
    organizationId: string
  }): Promise<{
    id: string
    title: string
    category: string
    amount: number
    organizationId: string | null
    status: string
    xeroSyncStatus: string
    paymentType: string
    employeeProfileId: string | null
    alreadyAttachedRunId: string | null
  } | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.claim.findFirst({
      where: { id: input.claimId, organizationId: input.organizationId },
      select: {
        id: true,
        title: true,
        category: true,
        amount: true,
        organizationId: true,
        status: true,
        xeroSyncStatus: true,
        paymentType: true,
        employee: {
          select: {
            employeeProfile: { select: { id: true } },
          },
        },
        payrollRunAttachment: { select: { payrollRunId: true } },
      },
    })
    if (!row) return null

    return {
      id: row.id,
      title: row.title,
      category: row.category,
      amount: toNumber(row.amount, 0),
      organizationId: row.organizationId,
      status: row.status,
      xeroSyncStatus: row.xeroSyncStatus,
      paymentType: row.paymentType,
      employeeProfileId: row.employee.employeeProfile?.id ?? null,
      alreadyAttachedRunId: row.payrollRunAttachment?.payrollRunId ?? null,
    }
  },
}
