import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"
import { getOrSetCache } from "@/lib/cache"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { key } from "@/lib/redis"
import {
  buildReportFileName,
  PAYROLL_REPORT_META,
  payrollReportKinds,
  type PayrollReportKind,
  type PayrollReportRow,
} from "@/modules/payroll/domain/reports"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { renderPayrollReport } from "@/modules/payroll/application/services/report-renderers"

/**
 * Page-data + on-demand streaming service for the "Download files" modal
 * on the payroll run detail page.
 *
 * Storage model: NOTHING is written to disk and NOTHING is cache-indexed
 * in the DB. Every download re-renders the requested file from the
 * (Redis-cached) payroll data and the bytes are streamed straight back
 * with `Content-Disposition: attachment` + `Cache-Control: no-store`.
 * The underlying payroll data is cheap to re-read (`getOrSetCache`), so
 * re-rendering on every click keeps the statutory files always in sync
 * with the live run — no stale files on disk, no cache-index rows to
 * clean up on revert.
 *
 * - `getPayrollReportsModalData` returns the static per-kind meta rows
 *   the modal renders, plus `canGenerate` (gated on `status = SUBMITTED`).
 * - `readPayrollReportFile` renders one file on demand and returns its
 *   bytes for a route handler to stream.
 */

export async function getPayrollReportsModalData(input: {
  runId: string
}): Promise<{
  runId: string
  organizationName: string
  periodLabel: string
  status: string
  rows: PayrollReportRow[]
  /// True when the underlying run is SUBMITTED. The modal disables every
  /// download button when this is false.
  canGenerate: boolean
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // 10-min TTL; busted by `bustPayrollCaches` on run mutations. Keyed by
  // runId. Nothing per-file is stored any more, so this only caches the
  // run's period/status/org-name for the modal header.
  return getOrSetCache(
    key("org", orgId, "payroll", "page", "reports-modal", input.runId),
    600,
    () => loadReportsModalData(orgId, input.runId),
  )
}

async function loadReportsModalData(
  orgId: string,
  runId: string,
): Promise<{
  runId: string
  organizationName: string
  periodLabel: string
  status: string
  rows: PayrollReportRow[]
  canGenerate: boolean
} | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  const [run, org] = await Promise.all([
    payrollRunRepository.getByIdForOrg({
      id: runId,
      organizationId: orgId,
    }),
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
  ])

  if (!run) return null

  // Every download is rendered on demand, so there's no per-run
  // "generated" state to merge — every row is just the static meta.
  const rows: PayrollReportRow[] = payrollReportKinds.map((kind) => ({
    ...PAYROLL_REPORT_META[kind],
    generated: null,
  }))

  return {
    runId: run.id,
    organizationName: org?.name ?? "",
    periodLabel: `${run.periodMonth.toString().padStart(2, "0")}/${run.periodYear}`,
    status: run.status,
    rows,
    canGenerate: run.status === "SUBMITTED",
  }
}

/**
 * Render one payroll report file on demand and return its bytes for a
 * route handler to stream back with a proper `Content-Disposition`.
 *
 * No disk, no repo, no cache read — the file is produced fresh from the
 * matching renderer every time. Gated on `status = SUBMITTED` (these are
 * post-finalisation outputs). Returns null when the session/org doesn't
 * match, the run can't be found, or it isn't submitted yet.
 */
export async function readPayrollReportFile(input: {
  runId: string
  kind: PayrollReportKind
  /// Optional admin-supplied payment date (PB ECP only). ISO YYYY-MM-DD.
  paymentDate?: string
}): Promise<{
  bytes: Buffer
  fileName: string
  mimeType: string
} | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null
  // Preserve the admin's policy scope for the PDF reports (summary /
  // payslips / schedule / PCB form) — a restricted admin only sees their
  // employees, exactly as before this went session-free. The token
  // endpoint passes no scope, so it renders the whole run.
  const policyIdScope = await getActiveAdminPolicyScope()
  return renderPayrollReportFileForOrg({
    ...input,
    organizationId: orgId,
    policyIdScope,
  })
}

/**
 * Session-independent twin of `readPayrollReportFile`. Takes an explicit
 * `organizationId` that the caller has already authorised, instead of
 * reading the admin session — so the token-authenticated `/api/v1`
 * payroll download endpoint can reuse the exact same on-demand renderer.
 * Same SUBMITTED gate + cross-tenant scoping: `getByIdForOrg` returns null
 * for a run that belongs to a different org, so no bytes ever cross tenants.
 */
export async function renderPayrollReportFileForOrg(input: {
  runId: string
  kind: PayrollReportKind
  organizationId: string
  /// Policy scope for the payslip-backed PDF reports. Omit (or null) to
  /// render the whole run — correct for the org-scoped token endpoint. The
  /// in-app caller passes the admin's scope so restricted admins keep
  /// seeing only their employees.
  policyIdScope?: string[] | null
  paymentDate?: string
}): Promise<{
  bytes: Buffer
  fileName: string
  mimeType: string
} | null> {
  const orgId = input.organizationId

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) return null
  // SUBMITTED gate — statutory outputs are only produced for finalised
  // runs. Drafts return null (→ 404) so the browser never gets bytes.
  if (run.status !== "SUBMITTED") return null

  let fileName = buildReportFileName({
    kind: input.kind,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    generatedAt: new Date(),
  })

  // PB ECP is the one kind where the admin-supplied payment date is part
  // of the file CONTENT (Row 1) + filename (DDMMYY). Payment date
  // defaults to the last day of the period month when the admin doesn't
  // override it. The bank-spec filename (`<account>PR<DDMMYY><NN>.xlsx`)
  // overrides the generic name so the download is upload-ready into PB
  // enterprise.
  let resolvedPaymentDate: Date | undefined
  if (input.kind === "BANK_PB_ECP_XLSX") {
    const { payrollSettingsRepository } = await import(
      "@/modules/payroll/infrastructure/payroll-settings.repository"
    )
    const { buildPbEcpFileName } = await import(
      "@/modules/payroll/application/services/report-renderers/pb-ecp-xlsx"
    )
    const settings = await payrollSettingsRepository.getByOrgId(orgId)
    const acc = settings?.ecpPayorAccountNo ?? "0000000000"
    resolvedPaymentDate = input.paymentDate
      ? parseIsoDate(input.paymentDate)
      : new Date(run.periodYear, run.periodMonth, 0)
    fileName = buildPbEcpFileName({
      payorAccountNo: acc,
      paymentDate: resolvedPaymentDate,
    })
  }

  const bytes = await renderPayrollReport({
    runId: run.id,
    kind: input.kind,
    organizationId: orgId,
    policyIdScope: input.policyIdScope ?? null,
    paymentDate: resolvedPaymentDate,
  })

  return {
    bytes,
    fileName,
    mimeType: PAYROLL_REPORT_META[input.kind].mimeType,
  }
}

/// Parse a YYYY-MM-DD string into a Date at local midnight.
function parseIsoDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number)
  if (!y || !m || !d) return new Date()
  return new Date(y, m - 1, d)
}
