import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import type { PayrollRunRow } from "@/modules/payroll/domain/runs"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"

/**
 * GET /api/v1/payroll-runs
 *
 * Required scope: `payroll:read`.
 *
 * Query params:
 *   - status (optional): DRAFT | PENDING_APPROVAL | SUBMITTED — filter
 *     the list to a single state. Useful for the external "what's
 *     waiting to be approved" poll: `?status=PENDING_APPROVAL`.
 *   - limit (optional, 1..200, default 50)
 *   - offset (optional, default 0)
 *
 * Returns the same `data + pagination` envelope as the
 * `/employees` list endpoint so consumers can paginate uniformly.
 *
 * Example response:
 *   {
 *     "data": [
 *       {
 *         "id": "ckxyz...",
 *         "periodYear": 2026,
 *         "periodMonth": 5,
 *         "status": "PENDING_APPROVAL",
 *         "totalGross": 145320.50,
 *         "totalNet": 121870.25,
 *         ...
 *       }
 *     ],
 *     "pagination": { "total": 18, "limit": 50, "offset": 0, "hasMore": false }
 *   }
 */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const VALID_STATUSES = ["DRAFT", "PENDING_APPROVAL", "SUBMITTED"] as const
type ValidStatus = (typeof VALID_STATUSES)[number]

export const GET = handleApiRequest(["payroll:read"], async (request, ctx) => {
  const url = new URL(request.url)
  const limit = clampInt(url.searchParams.get("limit"), 1, MAX_LIMIT, DEFAULT_LIMIT)
  const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0)
  const statusRaw = url.searchParams.get("status")?.trim().toUpperCase() ?? ""
  const statusFilter: ValidStatus | null = (VALID_STATUSES as readonly string[]).includes(
    statusRaw,
  )
    ? (statusRaw as ValidStatus)
    : null

  // The repo always loads the full list — fine for now (orgs typically
  // have ≤ 24 runs after 2 years on the platform). If this becomes a
  // hot path we can move the status filter + slice into the repo.
  const all = await payrollRunRepository.listForOrganization(
    ctx.integration.organizationId,
  )

  const filtered = statusFilter
    ? all.filter((r) => r.status === statusFilter)
    : all
  const slice = filtered.slice(offset, offset + limit)

  return NextResponse.json({
    data: slice.map(toExternalRun),
    pagination: {
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + limit < filtered.length,
    },
  })
})

/**
 * Project a `PayrollRunRow` to the external API shape. We:
 *   - Drop fields that mean nothing outside the app (`updatedAt`,
 *     `lastMutatedAt`, internal Xero error strings).
 *   - Keep monetary totals as plain numbers (the repo already coerces
 *     Decimal → number via `toNumber`).
 *   - Keep the audit-trail timestamps that callers might want
 *     (submittedAt, submittedForApprovalAt) so an automated system can
 *     reconcile against its own logs.
 */
function toExternalRun(row: PayrollRunRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    periodYear: row.periodYear,
    periodMonth: row.periodMonth,
    status: row.status,
    totals: {
      gross: row.totalGross,
      net: row.totalNet,
      pcb: row.totalPcb,
      zakat: row.totalZakat,
      hrdf: row.totalHrdf,
      employeeEpf: row.totalEmployeeEpf,
      employerEpf: row.totalEmployerEpf,
      employeeSocso: row.totalEmployeeSocso,
      employerSocso: row.totalEmployerSocso,
      employeeEis: row.totalEmployeeEis,
      employerEis: row.totalEmployerEis,
      costToEmployer: row.totalCostToEmployer,
      employeeCount: row.employeeCount,
      payslipCount: row.payslipCount,
    },
    submittedForApprovalAt: row.submittedForApprovalAt,
    submittedForApprovalById: row.submittedForApprovalById,
    submittedAt: row.submittedAt,
    submittedById: row.submittedById,
    approvalRejectionReason: row.approvalRejectionReason,
    xeroSync: {
      status: row.xeroSyncStatus,
      manualJournalId: row.xeroManualJournalId,
      journalNumber: row.xeroJournalNumber,
      syncedAt: row.xeroSyncedAt,
    },
    createdAt: row.createdAt,
  }
}

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw == null) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
