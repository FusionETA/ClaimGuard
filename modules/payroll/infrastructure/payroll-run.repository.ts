import "server-only"

import { Prisma } from "@/generated/prisma/client"

import { getPrismaClient } from "@/lib/prisma"
import { toNumber } from "@/lib/decimal"
import type { PayrollRunData, PayrollRunRow } from "@/modules/payroll/domain/runs"

/**
 * Thrown by `findOrCreateImportedRun` when the requested period is
 * already occupied by a COMPUTED run (DRAFT / PENDING / SUBMITTED).
 * Caller (the YTD importer) treats this as a per-month skip and
 * surfaces it on the upload summary rather than aborting the whole
 * batch. Subclassing Error keeps it `instanceof Error` for catch
 * sites that handle it generically.
 */
export class ImportedRunConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImportedRunConflictError"
  }
}

/// Coerce the stored `PayrollRun.policyIds` Json column back into a
/// `string[] | null` for the domain shape. `null` (legacy or org-wide)
/// stays null; everything else is filtered to string entries.
function jsonToPolicyIds(value: unknown): string[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return null
  return value.filter((v): v is string => typeof v === "string")
}

/**
 * Module-scoped Prisma accessor for the payroll module. Services call
 * this instead of `getPrismaClient()` from `@/lib/prisma` so all
 * payroll-related DB access flows through the infrastructure layer
 * (which is what the layered-architecture rule enforces).
 *
 * The payroll module is the largest in the repo and contains delicate
 * tax-calculation code — exposing a typed accessor lets us keep the
 * complex transactional payroll-run and import services readable while
 * still routing every query through the infrastructure layer.
 *
 * Throws when `DATABASE_URL` is unset. Use the `*Safe` variant for read
 * paths that want to render an empty state instead of throwing.
 */
export function getPayrollPrismaClient() {
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured")
  return prisma
}

export function getPayrollPrismaClientSafe() {
  return getPrismaClient()
}

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
    /// Employee-policy ids this run is scoped to. `null` = org-wide
    /// (legacy default). The service is responsible for validating
    /// that every id is one the creating admin has access to.
    policyIds?: string[] | null
  }): Promise<PayrollRunData> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const policyIds = input.policyIds ?? null
    const row = await prisma.payrollRun.create({
      data: {
        organizationId: input.organizationId,
        periodYear: input.periodYear,
        periodMonth: input.periodMonth,
        status: "DRAFT",
        policyIds: policyIds === null ? Prisma.JsonNull : policyIds,
      },
    })
    return mapPayrollRun(row)
  },

  /**
   * Get-or-create the IMPORTED PayrollRun for (org, year, month).
   * Idempotent: re-uploading is safe — the same period is reused so
   * subsequent rows attach as new payslips on the same run.
   *
   * Behavior:
   *   - If no run exists yet → creates one with source = IMPORTED,
   *     status = SUBMITTED, submittedAt = last day of the period.
   *   - If a run exists with source = IMPORTED → returns it (admin is
   *     adding more employees to an in-progress migration).
   *   - If a run exists with source = COMPUTED (DRAFT, PENDING, or
   *     SUBMITTED) → throws. Imports must never coexist with engine
   *     output for the same period; the importer treats this as a
   *     skip condition and surfaces it on the summary.
   */
  async findOrCreateImportedRun(input: {
    organizationId: string
    periodYear: number
    periodMonth: number
    submittedById: string | null
  }): Promise<{ run: PayrollRunData; created: boolean }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const existing = await prisma.payrollRun.findFirst({
      where: {
        organizationId: input.organizationId,
        periodYear: input.periodYear,
        periodMonth: input.periodMonth,
      },
    })
    if (existing) {
      if (existing.source !== "IMPORTED") {
        throw new ImportedRunConflictError(
          `An existing ${existing.status} run already covers ${input.periodYear}-${String(input.periodMonth).padStart(2, "0")}.`,
        )
      }
      return { run: mapPayrollRun(existing), created: false }
    }
    // Last day of the period — Date.UTC keeps timezone drift out.
    const submittedAt = new Date(
      Date.UTC(input.periodYear, input.periodMonth, 0, 23, 59, 59, 999),
    )
    const row = await prisma.payrollRun.create({
      data: {
        organizationId: input.organizationId,
        periodYear: input.periodYear,
        periodMonth: input.periodMonth,
        status: "SUBMITTED",
        source: "IMPORTED",
        submittedAt,
        submittedById: input.submittedById ?? undefined,
        policyIds: Prisma.JsonNull,
      },
    })
    return { run: mapPayrollRun(row), created: true }
  },

  /**
   * Every SUBMITTED run's period for an org. Used to derive loan
   * repayment progress (which installments have actually been paid out
   * on a finalised run).
   */
  async listSubmittedPeriods(
    organizationId: string,
  ): Promise<Array<{ year: number; month: number }>> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.payrollRun.findMany({
      where: { organizationId, status: "SUBMITTED" },
      select: { periodYear: true, periodMonth: true },
    })
    return rows.map((r) => ({ year: r.periodYear, month: r.periodMonth }))
  },

  /**
   * Annual statutory forms are only valid once every month in the
   * calendar year has a finalised payroll run. Return submitted-month
   * coverage so the page can explain what's still missing and the
   * generation action can enforce the same rule server-side.
   */
  async getAnnualSubmissionCoverage(input: {
    organizationId: string
    year: number
  }): Promise<{
    submittedMonths: number[]
    missingMonths: number[]
    complete: boolean
  }> {
    const prisma = getPrismaClient()
    if (!prisma) {
      return {
        submittedMonths: [],
        missingMonths: Array.from({ length: 12 }, (_, i) => i + 1),
        complete: false,
      }
    }

    const rows = await prisma.payrollRun.findMany({
      where: {
        organizationId: input.organizationId,
        periodYear: input.year,
        status: "SUBMITTED",
      },
      select: { periodMonth: true },
    })
    const submitted = new Set(rows.map((r) => r.periodMonth))
    const submittedMonths = Array.from(submitted).sort((a, b) => a - b)
    const missingMonths = Array.from({ length: 12 }, (_, i) => i + 1).filter(
      (month) => !submitted.has(month),
    )
    return {
      submittedMonths,
      missingMonths,
      complete: missingMonths.length === 0,
    }
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
   * True iff the org has ANY SUBMITTED payroll run whose period is
   * strictly BEFORE the given period (across all prior years).
   *
   * Used by the chronological-order guard on submit to distinguish
   * "first run for this org, no prior months required" from "org has
   * been running payroll for months, and someone is trying to submit
   * ahead of a gap".
   */
  async hasEarlierSubmittedRun(input: {
    organizationId: string
    periodYear: number
    periodMonth: number
  }): Promise<boolean> {
    const prisma = getPrismaClient()
    if (!prisma) return false
    const row = await prisma.payrollRun.findFirst({
      where: {
        organizationId: input.organizationId,
        status: "SUBMITTED",
        OR: [
          { periodYear: { lt: input.periodYear } },
          {
            periodYear: input.periodYear,
            periodMonth: { lt: input.periodMonth },
          },
        ],
      },
      select: { id: true },
    })
    return row !== null
  },

  /**
   * Return the earliest submitted run after the requested period.
   * Backdated drafts are only blocked by submitted later periods;
   * later drafts remain editable and do not lock chronology.
   */
  async findNextSubmittedAfterPeriod(input: {
    organizationId: string
    periodYear: number
    periodMonth: number
  }): Promise<PayrollRunData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.payrollRun.findFirst({
      where: {
        organizationId: input.organizationId,
        status: "SUBMITTED",
        OR: [
          { periodYear: { gt: input.periodYear } },
          {
            periodYear: input.periodYear,
            periodMonth: { gt: input.periodMonth },
          },
        ],
      },
      orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
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
    /// Optional employee-policy scope. Affects the `payslipCount` shown
    /// on the run header — restricted admins see the count of payslips
    /// for employees they can see, not the run-wide count. `null` =
    /// no scope (owner / legacy admin).
    policyIdScope?: string[] | null
  }): Promise<PayrollRunRow | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const policyIdScope = input.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) {
      // Restricted admin with no policy scope still sees the run row
      // (so they don't 404), but `payslipCount` reports 0.
      const row0 = await prisma.payrollRun.findFirst({
        where: { id: input.id, organizationId: input.organizationId },
      })
      if (!row0) return null
      return { ...mapPayrollRun(row0), payslipCount: 0 }
    }

    const row = await prisma.payrollRun.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      include: {
        _count: {
          select: {
            payslips:
              policyIdScope && policyIdScope.length > 0
                ? {
                    where: {
                      employeeProfile: {
                        policyId: { in: policyIdScope },
                      },
                    },
                  }
                : true,
          },
        },
      },
    })
    if (!row) return null
    return { ...mapPayrollRun(row), payslipCount: row._count.payslips }
  },

  /**
   * Submit a DRAFT run for approval, transitioning DRAFT →
   * PENDING_APPROVAL. Records `submittedForApprovalAt` and
   * `submittedForApprovalById`. Throws if not in DRAFT.
   *
   * Also clears any prior `approvalRejectionReason` so a previously-
   * bounced run doesn't carry its old rejection note forward.
   */
  async submitForApproval(input: {
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
      throw new Error("Only draft runs can be submitted for approval.")
    }

    await prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        status: "PENDING_APPROVAL",
        submittedForApprovalAt: new Date(),
        submittedForApprovalById: input.submittedById,
        approvalRejectionReason: null,
      },
    })
  },

  /**
   * Approve a PENDING_APPROVAL run, transitioning PENDING_APPROVAL
   * → SUBMITTED. Records `submittedAt` + `submittedById` for the
   * audit trail of who finalised the run. Per the org's policy any
   * admin can approve, including the submitter themselves.
   */
  async approve(input: {
    id: string
    organizationId: string
    approvedById: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const run = await prisma.payrollRun.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { id: true, status: true },
    })
    if (!run) throw new Error("Payroll run not found.")
    if (run.status !== "PENDING_APPROVAL") {
      throw new Error("Only runs awaiting approval can be approved.")
    }

    await prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        status: "SUBMITTED",
        submittedAt: new Date(),
        submittedById: input.approvedById,
      },
    })
  },

  /**
   * Approver sends a PENDING_APPROVAL run back to DRAFT with an
   * optional reason. Submitter can then edit and resubmit. The
   * reason persists on the run as audit (and as a hint to the
   * submitter). `submittedForApprovalAt` is cleared so re-submission
   * gets a fresh timestamp.
   */
  async rejectApproval(input: {
    id: string
    organizationId: string
    reason: string | null
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const run = await prisma.payrollRun.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { id: true, status: true },
    })
    if (!run) throw new Error("Payroll run not found.")
    if (run.status !== "PENDING_APPROVAL") {
      throw new Error(
        "Only runs awaiting approval can be sent back to draft.",
      )
    }

    await prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        status: "DRAFT",
        submittedForApprovalAt: null,
        submittedForApprovalById: null,
        approvalRejectionReason: input.reason ?? null,
      },
    })
  },

  /**
   * Reverse a SUBMITTED run back to DRAFT. Clears `submittedAt` and
   * `submittedById`. Existing payslips and claim attachments stay in
   * place — the admin can regenerate or edit then re-submit for
   * approval. Skips PENDING_APPROVAL (use `rejectApproval` for that).
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
   * List SUBMITTED runs in the same org + calendar year whose period
   * month is strictly AFTER `afterMonth`. Used when reverting an
   * earlier month: those later months' YTD-cumulative figures (PCB,
   * SOCSO+EIS relief) depend on the reverted month, so they must
   * cascade back to draft too. Ordered ascending by month.
   */
  async listSubmittedLaterInYear(input: {
    organizationId: string
    periodYear: number
    afterMonth: number
  }): Promise<Array<{ id: string; periodYear: number; periodMonth: number }>> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    return prisma.payrollRun.findMany({
      where: {
        organizationId: input.organizationId,
        periodYear: input.periodYear,
        periodMonth: { gt: input.afterMonth },
        status: "SUBMITTED",
      },
      select: { id: true, periodYear: true, periodMonth: true },
      orderBy: { periodMonth: "asc" },
    })
  },

  /**
   * Bump the `lastMutatedAt` timestamp on a run — called after every
   * content-level mutation: claim attach, detach, adjustment save,
   * adjustment clear. Drives the "stale run" warning by being
   * compared against the latest `Payslip.createdAt`. Generate
   * doesn't bump this; only user edits do.
   *
   * Best-effort: if the run doesn't exist (unusual — caller should
   * have verified earlier) the update is a no-op rather than
   * raising, so a benign race condition doesn't fail the parent
   * mutation that already succeeded.
   */
  /**
   * Bump `lastMutatedAt` on every DRAFT run in an org. Called when a
   * payroll-calc-affecting field changes on an employee's profile
   * (SOCSO scheme, PCB-borne-by-employer toggle, EPF rate, date of
   * birth, citizenship flag, etc.) — any open draft for that month
   * now reflects a stale calc and the admin must click Generate again
   * to refresh the cached payslip numbers. We sweep all DRAFTS rather
   * than per-employee because:
   *   - Drafts already filter by joinDate / leaveDate; the affected
   *     employee may not be in every draft, but Generate is idempotent.
   *   - Querying "drafts that already have a payslip for this
   *     employeeId" requires another join. The blunt sweep is cheaper
   *     and the worst case is one extra Generate click on a draft
   *     that didn't actually need it.
   *
   * No-op when there are no DRAFTs. Best-effort: errors are logged but
   * not re-thrown so the caller's primary save isn't blocked by this
   * UX-only timestamp.
   */
  async markDraftsStaleForOrg(organizationId: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return
    try {
      await prisma.payrollRun.updateMany({
        where: { organizationId, status: "DRAFT" },
        data: { lastMutatedAt: new Date() },
      })
    } catch (err) {
      console.error("[payrollRunRepository.markDraftsStaleForOrg]", {
        organizationId,
        err,
      })
    }
  },

  /**
   * List DRAFT runs for an org (id + period only). Used after a
   * profile save to tell the admin which runs were just marked stale
   * so the UI can render a "Re-run payroll" toast link. Returns
   * newest period first.
   */
  async listDraftsForOrg(
    organizationId: string,
  ): Promise<Array<{ id: string; periodYear: number; periodMonth: number }>> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    try {
      const rows = await prisma.payrollRun.findMany({
        where: { organizationId, status: "DRAFT" },
        select: { id: true, periodYear: true, periodMonth: true },
        orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
      })
      return rows
    } catch (err) {
      console.error("[payrollRunRepository.listDraftsForOrg]", {
        organizationId,
        err,
      })
      return []
    }
  },

  async markMutated(runId: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return
    try {
      await prisma.payrollRun.update({
        where: { id: runId },
        data: { lastMutatedAt: new Date() },
      })
    } catch (err) {
      // The user's actual mutation succeeded; the staleness flag is
      // a UX nicety, so we don't re-throw. But we DO log so silent
      // failures don't lead to the "I changed things but the banner
      // never appears" bug class going undetected.
      console.error("[payrollRunRepository.markMutated]", { runId, err })
    }
  },

  /**
   * Clear the pending-mutation flag — called from the Generate flow
   * right after fresh payslips are written. This is what flips the
   * "stale run" warning off: with `lastMutatedAt` back to null, the
   * Submit button re-enables. Also called once during the column
   * migration so legacy rows aren't false-positive flagged.
   */
  async clearMutated(runId: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return
    try {
      await prisma.payrollRun.update({
        where: { id: runId },
        data: { lastMutatedAt: null },
      })
    } catch (err) {
      console.error("[payrollRunRepository.clearMutated]", { runId, err })
    }
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

  /**
   * Per-year context for the YTD import dialog. Returns which months
   * in the calendar year already have a run on file, split by source.
   *
   *   - importedMonths: months with source=IMPORTED. Re-uploading
   *     this year wipes these and replaces with the new file.
   *   - computedMonths: months with source=COMPUTED (DRAFT / PENDING
   *     / SUBMITTED). A new upload that touches any of these gets
   *     rejected entirely (engine output is never overwritten by an
   *     import). The dialog uses this to warn admin upfront.
   *
   * Cheap — projects a tiny slice (status + month) per row, no
   * payslips loaded. Safe to call on every year-picker change.
   */
  async listMonthsByYear(input: {
    organizationId: string
    year: number
  }): Promise<{
    importedMonths: number[]
    computedMonths: number[]
  }> {
    const prisma = getPrismaClient()
    if (!prisma) return { importedMonths: [], computedMonths: [] }
    const rows = await prisma.payrollRun.findMany({
      where: {
        organizationId: input.organizationId,
        periodYear: input.year,
      },
      select: { periodMonth: true, source: true },
      orderBy: { periodMonth: "asc" },
    })
    const importedMonths: number[] = []
    const computedMonths: number[] = []
    for (const r of rows) {
      if (r.source === "IMPORTED") importedMonths.push(r.periodMonth)
      else computedMonths.push(r.periodMonth)
    }
    return { importedMonths, computedMonths }
  },

  /**
   * Atomically wipe every IMPORTED run for an org-year. Used by the YTD
   * importer right before it writes the new upload — the "one year, one
   * upload" rule means the latest upload is the single source of truth,
   * so any prior IMPORTED rows for that year get deleted in the same
   * transaction that creates the new ones.
   *
   * Cascade: PayrollRun has `payslips Payslip[]` with `onDelete: Cascade`,
   * so deleting the runs cascades through to their payslips. Returns
   * the count for the summary panel.
   *
   * NEVER touches COMPUTED runs — the conflict-check in the import
   * service must have already failed any upload that overlaps a
   * COMPUTED period.
   */
  async deleteImportedRunsForYear(input: {
    organizationId: string
    year: number
  }): Promise<{ runsDeleted: number }> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const result = await prisma.payrollRun.deleteMany({
      where: {
        organizationId: input.organizationId,
        periodYear: input.year,
        source: "IMPORTED",
      },
    })
    return { runsDeleted: result.count }
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
    // `source` was added later — old rows without the column read as
    // undefined. Default to COMPUTED so the existing audit-card split
    // doesn't misclassify legacy runs as imports.
    source: row.source ?? "COMPUTED",
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
    submittedForApprovalAt: row.submittedForApprovalAt
      ? row.submittedForApprovalAt.toISOString()
      : null,
    submittedForApprovalById: row.submittedForApprovalById ?? null,
    approvalRejectionReason: row.approvalRejectionReason ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    // Null when no pending content mutations since the last
    // generation (or since migration). Generate clears this; mutations
    // set it. The UI's stale-run check is null-safe.
    lastMutatedAt: row.lastMutatedAt
      ? row.lastMutatedAt.toISOString()
      : null,
    xeroManualJournalId: row.xeroManualJournalId ?? null,
    xeroJournalNumber: row.xeroJournalNumber ?? null,
    xeroSyncStatus: row.xeroSyncStatus ?? "NOT_SYNCED",
    xeroSyncError: row.xeroSyncError ?? null,
    xeroSyncedAt: row.xeroSyncedAt
      ? row.xeroSyncedAt.toISOString()
      : null,
    policyIds: jsonToPolicyIds(row.policyIds),
  }
}
