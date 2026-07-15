import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"
import type { ManualLineItem } from "@/modules/payroll/domain/runs"
import { periodLabel } from "@/modules/payroll/domain/runs"
import {
  parseAdjustmentImport,
  type ParsedAdjustmentRow,
} from "@/modules/payroll/application/services/report-renderers/run-adjustment-import-parser"
import { renderAdjustmentImportTemplate } from "@/modules/payroll/application/services/report-renderers/run-adjustment-import-template"
import { payrollProfileRepository } from "@/modules/payroll/infrastructure/payroll-profile.repository"
import { payrollRunAdjustmentRepository } from "@/modules/payroll/infrastructure/payroll-run-adjustment.repository"
import {
  getPayrollPrismaClientSafe,
  payrollRunRepository,
} from "@/modules/payroll/infrastructure/payroll-run.repository"

/**
 * Bulk-import one-off manual line items into a DRAFT payroll run from
 * an XLSX file. REPLACE semantics: every existing manualLineItems
 * column on the run is wiped and rebuilt from the file. Fixed-allowance
 * overrides, OT hours, worked/expected hours, and notes are LEFT
 * ALONE — the importer only touches the manual line items.
 *
 * Product rules:
 *   - DRAFT runs only. SUBMITTED / PENDING_APPROVAL runs are locked.
 *   - Employee matching is by full name (case-insensitive), scoped to
 *     the run's org. Names that don't match any active profile —
 *     REJECT the whole file. Names that match multiple profiles —
 *     REJECT the whole file (admin must disambiguate manually).
 *   - Any per-row structural error → REJECT the whole file, no writes.
 */

// ─── Template download ──────────────────────────────────────────────

export async function generateAdjustmentImportTemplate(input: {
  runId: string
}): Promise<{ buffer: Buffer; filename: string }> {
  const { orgId } = await requireAdminSession()
  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Run not found.")

  // Pre-populate with the run's eligible employees + any existing
  // manual line items already on the run. Since import is REPLACE
  // semantics, showing what's already there is important — admins
  // shouldn't have to remember to re-add lines they meant to keep.
  const [employees, existingAdjustments] = await Promise.all([
    payrollProfileRepository.listReadyForPayroll(orgId, {
      period: { year: run.periodYear, month: run.periodMonth },
    }),
    payrollRunAdjustmentRepository.listForRun(run.id),
  ])

  // Reverse-lookup: category code → human label used by the parser.
  const codeToLabel = new Map<string, string>()
  for (const meta of Object.values(PAYROLL_ADJUSTMENT_CATEGORY_META)) {
    codeToLabel.set(meta.code, meta.label)
  }

  const buffer = await renderAdjustmentImportTemplate({
    periodLabel: periodLabel(run.periodYear, run.periodMonth),
    employees: employees.map((e) => {
      const adj = existingAdjustments.get(e.employeeProfileId)
      const items = (adj?.manualLineItems ?? []).map((li) => ({
        categoryLabel: codeToLabel.get(li.category) ?? li.category,
        treatAsRecurring: li.treatAsRecurring,
        label: li.label,
        amount: li.amount,
      }))
      return {
        name: e.name || "(no name)",
        existingLines: items,
      }
    }),
  })

  const slug = periodLabel(run.periodYear, run.periodMonth)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return {
    buffer,
    filename: `payroll-adjustments-${slug}.xlsx`,
  }
}

// ─── Import ─────────────────────────────────────────────────────────

export type AdjustmentImportSummary = {
  status: "success"
  employeesAffected: number
  linesWritten: number
  employeesWithoutFileEntry: number
  /// Populated when the auto re-run after the import failed. The
  /// import itself succeeded; this is a soft warning telling the
  /// admin they should click Re-run payroll to refresh totals.
  rerunWarning?: string
}

export type AdjustmentImportError = {
  status: "error"
  message: string
  rowErrors?: Array<{ rowNumber: number; message: string }>
}

export async function importPayrollRunAdjustments(input: {
  runId: string
  fileBuffer: ArrayBuffer
}): Promise<AdjustmentImportSummary | AdjustmentImportError> {
  const { orgId } = await requireAdminSession()

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) {
    return { status: "error", message: "Run not found." }
  }
  if (run.status !== "DRAFT") {
    return {
      status: "error",
      message:
        "Bulk import is only available on draft runs. This run has already been submitted.",
    }
  }

  // ── Parse ─────────────────────────────────────────────────────────
  const parsed = await parseAdjustmentImport(input.fileBuffer)
  if (parsed.errors.length > 0) {
    return { status: "error", message: parsed.errors.join(" ") }
  }
  if (parsed.rowErrors.length > 0) {
    return {
      status: "error",
      message: `File has ${parsed.rowErrors.length} problem row${parsed.rowErrors.length === 1 ? "" : "s"}. Fix and re-upload.`,
      rowErrors: parsed.rowErrors.slice(0, 30),
    }
  }
  if (parsed.rows.length === 0) {
    return { status: "error", message: "The file has no data rows." }
  }

  // ── Resolve full names to employee profiles on this run ───────────
  const eligible = await payrollProfileRepository.listReadyForPayroll(
    orgId,
    { period: { year: run.periodYear, month: run.periodMonth } },
  )

  const byName = new Map<string, string[]>() // normalisedName → employeeProfileIds
  for (const e of eligible) {
    const key = normaliseName(e.name)
    if (key.length === 0) continue
    const list = byName.get(key) ?? []
    list.push(e.employeeProfileId)
    byName.set(key, list)
  }

  const unmatched = new Set<string>()
  const ambiguous = new Set<string>()
  const resolved: Array<{
    profileId: string
    row: ParsedAdjustmentRow
  }> = []
  for (const row of parsed.rows) {
    const key = normaliseName(row.fullName)
    const matches = byName.get(key) ?? []
    if (matches.length === 0) {
      unmatched.add(row.fullName)
      continue
    }
    if (matches.length > 1) {
      ambiguous.add(row.fullName)
      continue
    }
    resolved.push({ profileId: matches[0]!, row })
  }

  const nameProblems: string[] = []
  if (unmatched.size > 0) {
    nameProblems.push(
      `${unmatched.size} name${unmatched.size === 1 ? "" : "s"} didn't match anyone on this run: ${[
        ...unmatched,
      ]
        .slice(0, 8)
        .join(", ")}${unmatched.size > 8 ? "…" : ""}`,
    )
  }
  if (ambiguous.size > 0) {
    nameProblems.push(
      `${ambiguous.size} name${ambiguous.size === 1 ? "" : "s"} matched more than one employee: ${[
        ...ambiguous,
      ]
        .slice(0, 8)
        .join(", ")}${ambiguous.size > 8 ? "…" : ""}`,
    )
  }
  if (nameProblems.length > 0) {
    return {
      status: "error",
      message: `${nameProblems.join(" ")}. Fix the file and re-upload — no changes were made.`,
    }
  }

  // ── Group by profile and build ManualLineItem[] ───────────────────
  const groupedByProfile = new Map<string, ManualLineItem[]>()
  for (const { profileId, row } of resolved) {
    const items = groupedByProfile.get(profileId) ?? []
    items.push({
      kind: kindFromCategory(row.category),
      category: row.category,
      label: row.label,
      amount: row.amount,
      // Only persist the flag when the admin explicitly ticked/unticked
      // — leaving it undefined keeps the default AR behaviour for
      // AR-flagged categories, matching pre-column behaviour.
      ...(row.treatAsRecurring != null
        ? { treatAsRecurring: row.treatAsRecurring }
        : {}),
    })
    groupedByProfile.set(profileId, items)
  }

  // ── Write in a transaction: wipe every existing manualLineItems on
  //    the run, then upsert file entries. Fixed-allowance overrides,
  //    OT hours, worked/expected hours, and notes are untouched.
  const prisma = getPayrollPrismaClientSafe()
  if (!prisma) {
    return { status: "error", message: "Database is not configured." }
  }

  let linesWritten = 0
  await prisma.$transaction(async (tx) => {
    // Step 1 — wipe manualLineItems on every existing row for the run
    await tx.payrollRunAdjustment.updateMany({
      where: { payrollRunId: input.runId },
      data: { manualLineItems: [] },
    })

    // Step 2 — upsert the entries from the file
    for (const [profileId, items] of groupedByProfile.entries()) {
      await tx.payrollRunAdjustment.upsert({
        where: {
          payrollRunId_employeeProfileId: {
            payrollRunId: input.runId,
            employeeProfileId: profileId,
          },
        },
        create: {
          payrollRunId: input.runId,
          employeeProfileId: profileId,
          manualLineItems: items as unknown as object,
          fixedAllowanceOverrides: [],
        },
        update: {
          manualLineItems: items as unknown as object,
        },
      })
      linesWritten += items.length
    }
  })

  const employeesInFile = groupedByProfile.size
  const employeesWithoutFileEntry = Math.max(
    0,
    eligible.length - employeesInFile,
  )

  return {
    status: "success",
    employeesAffected: employeesInFile,
    linesWritten,
    employeesWithoutFileEntry,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

async function requireAdminSession(): Promise<{
  orgId: string
}> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")
  return { orgId }
}

function normaliseName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ")
}

function kindFromCategory(
  category: PayrollAdjustmentCategory,
): ManualLineItem["kind"] {
  const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[category]
  return meta.kind
}
