import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { toNumber } from "@/lib/decimal"
import type { PayrollRunData, PayrollRunRow } from "@/modules/payroll/domain/runs"

/**
 * Prisma-side repository for `PayrollRun`. Phase 3 scope — supports
 * draft creation, listing, fetching, and deleting drafts. Submission /
 * payslip writes land in Phase 4 alongside the calculation engine.
 *
 * Per the layered-architecture rule, ALL prisma access for this
 * aggregate lives here.
 */
export const payrollRunRepository = {
  /**
   * Create a new draft run for (org, year, month). Throws on conflict
   * — Prisma enforces the @@unique([organizationId, periodYear,
   * periodMonth]) constraint at the DB level.
   */
  async createDraft(input: {
    organizationId: string
    periodYear: number
    periodMonth: number
  }): Promise<PayrollRunData> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const row = await prisma.payrollRun.create({
      data: {
        organizationId: input.organizationId,
        periodYear: input.periodYear,
        periodMonth: input.periodMonth,
        status: "DRAFT",
      },
    })
    return mapPayrollRun(row)
  },

  /**
   * Lookup by (org, year, month). Returns null when no run exists for
   * that period. Used by the "new draft" action to short-circuit
   * before hitting the unique-constraint error.
   */
  async findByPeriod(input: {
    organizationId: string
    periodYear: number
    periodMonth: number
  }): Promise<PayrollRunData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.payrollRun.findUnique({
      where: {
        organizationId_periodYear_periodMonth: {
          organizationId: input.organizationId,
          periodYear: input.periodYear,
          periodMonth: input.periodMonth,
        },
      },
    })
    if (!row) return null
    return mapPayrollRun(row)
  },

  /**
   * List all runs for the org with payslip counts. Newest-first by
   * (year, month) so the list reads "March → February → January".
   */
  async listForOrganization(
    organizationId: string,
  ): Promise<PayrollRunRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.payrollRun.findMany({
      where: { organizationId },
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
      include: {
        _count: { select: { payslips: true } },
      },
    })

    return rows.map((row) => ({
      ...mapPayrollRun(row),
      payslipCount: row._count.payslips,
    }))
  },

  /**
   * Fetch a single run scoped to the org. Returns null if the run
   * doesn't exist OR belongs to a different org (defence-in-depth).
   */
  async getByIdForOrg(input: {
    id: string
    organizationId: string
  }): Promise<PayrollRunRow | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.payrollRun.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      include: {
        _count: { select: { payslips: true } },
      },
    })
    if (!row) return null
    return { ...mapPayrollRun(row), payslipCount: row._count.payslips }
  },

  /**
   * Submit a draft run, transitioning DRAFT → SUBMITTED. Records
   * `submittedAt` and `submittedById` for the audit trail. Throws if
   * the run is already SUBMITTED.
   */
  async submit(input: {
    id: string
    organizationId: string
    submittedById: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const run = await prisma.payrollRun.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { id: true, status: true },
    })
    if (!run) throw new Error("Payroll run not found.")
    if (run.status !== "DRAFT") {
      throw new Error("Run has already been submitted.")
    }

    await prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        status: "SUBMITTED",
        submittedAt: new Date(),
        submittedById: input.submittedById,
      },
    })
  },

  /**
   * Reverse a submitted run back to DRAFT. Clears `submittedAt` and
   * `submittedById`. Existing payslips and claim attachments stay in
   * place — the admin can regenerate or edit then re-submit.
   */
  async revertToDraft(input: {
    id: string
    organizationId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const run = await prisma.payrollRun.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { id: true, status: true },
    })
    if (!run) throw new Error("Payroll run not found.")
    if (run.status !== "SUBMITTED") {
      throw new Error("Only submitted runs can be reverted to draft.")
    }

    await prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        status: "DRAFT",
        submittedAt: null,
        submittedById: null,
      },
    })
  },

  /**
   * Delete a draft run. Throws if the run is SUBMITTED — submitted
   * runs are immutable. Cascade-deletes payslips via the Prisma
   * relation.
   */
  async deleteDraft(input: {
    id: string
    organizationId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const run = await prisma.payrollRun.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { id: true, status: true },
    })
    if (!run) throw new Error("Payroll run not found.")
    if (run.status !== "DRAFT") {
      throw new Error("Only draft runs can be deleted.")
    }

    await prisma.payrollRun.delete({ where: { id: run.id } })
  },
}

// ─── Projection helpers ──────────────────────────────────────────────────

function mapPayrollRun(row: any): PayrollRunData {
  return {
    id: row.id,
    organizationId: row.organizationId,
    periodYear: row.periodYear,
    periodMonth: row.periodMonth,
    status: row.status,
    totalGross: row.totalGross == null ? null : toNumber(row.totalGross, 0),
    totalNet: row.totalNet == null ? null : toNumber(row.totalNet, 0),
    totalEmployeeEpf:
      row.totalEmployeeEpf == null ? null : toNumber(row.totalEmployeeEpf, 0),
    totalEmployerEpf:
      row.totalEmployerEpf == null ? null : toNumber(row.totalEmployerEpf, 0),
    totalEmployeeSocso:
      row.totalEmployeeSocso == null
        ? null
        : toNumber(row.totalEmployeeSocso, 0),
    totalEmployerSocso:
      row.totalEmployerSocso == null
        ? null
        : toNumber(row.totalEmployerSocso, 0),
    totalEmployeeEis:
      row.totalEmployeeEis == null ? null : toNumber(row.totalEmployeeEis, 0),
    totalEmployerEis:
      row.totalEmployerEis == null ? null : toNumber(row.totalEmployerEis, 0),
    totalPcb: row.totalPcb == null ? null : toNumber(row.totalPcb, 0),
    totalHrdf: row.totalHrdf == null ? null : toNumber(row.totalHrdf, 0),
    totalZakat: row.totalZakat == null ? null : toNumber(row.totalZakat, 0),
    totalCostToEmployer:
      row.totalCostToEmployer == null
        ? null
        : toNumber(row.totalCostToEmployer, 0),
    employeeCount: row.employeeCount ?? null,
    employeesSubjectToHrdf: row.employeesSubjectToHrdf ?? null,
    totalWagesSubjectToHrdf:
      row.totalWagesSubjectToHrdf == null
        ? null
        : toNumber(row.totalWagesSubjectToHrdf, 0),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    submittedById: row.submittedById ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
