import "server-only"

import { createHash } from "node:crypto"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getOrSetCache } from "@/lib/cache"
import { bustPayrollCaches } from "@/lib/cache-invalidation"
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
import { payrollRunReportRepository } from "@/modules/payroll/infrastructure/payroll-run-report.repository"
import { renderPayrollReport } from "@/modules/payroll/application/services/report-renderers"

/**
 * Page-data + action service for the "Download files" modal on the
 * payroll run detail page.
 *
 * - `getPayrollReportsModalData` reads the cached report rows for one
 *   run and merges them with the static meta into the row shape the
 *   modal renders.
 * - `generatePayrollReport` lazily renders one file (or returns the
 *   cached entry if it already exists), writes it to disk under
 *   `public/uploads/payroll-reports/<runId>/`, and upserts the row.
 *
 * Generation is gated on `status = SUBMITTED` (these are
 * post-finalisation outputs). Revert-to-draft clears everything.
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
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  // 10-min TTL; busted by `bustPayrollCaches` on run mutations and on
  // every file generation (generatePayrollReport), so the per-row
  // "generated" stamps stay current. Keyed by runId.
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

  const [run, org, stored] = await Promise.all([
    payrollRunRepository.getByIdForOrg({
      id: runId,
      organizationId: orgId,
    }),
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    }),
    payrollRunReportRepository.listForRun(runId),
  ])

  if (!run) return null

  const storedByKind = new Map(stored.map((s) => [s.kind, s]))

  const rows: PayrollReportRow[] = payrollReportKinds.map((kind) => {
    const meta = PAYROLL_REPORT_META[kind]
    const cached = storedByKind.get(kind)
    return {
      ...meta,
      generated: cached
        ? {
            fileName: cached.fileName,
            fileUrl: cached.fileUrl,
            sizeBytes: cached.sizeBytes,
            generatedAt: cached.generatedAt.toISOString(),
          }
        : null,
    }
  })

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
 * Generate (or return the cached entry for) one payroll report file.
 *
 * If the file is already on disk + has a row in `PayrollRunReport`, we
 * short-circuit. Otherwise we call the matching renderer, hash + write
 * the bytes, then upsert the row.
 *
 * Returns the URL the browser should hit (relative `/uploads/...`).
 */
export async function generatePayrollReport(input: {
  runId: string
  kind: PayrollReportKind
  /// Override the payment date — only consumed by `BANK_PB_ECP_XLSX`.
  /// When set, the cached file is invalidated and re-rendered with
  /// the new date. ISO date string (YYYY-MM-DD).
  paymentDate?: string
}): Promise<{
  fileName: string
  fileUrl: string
  mimeType: string
  sizeBytes: number
  alreadyCached: boolean
}> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) throw new Error("Payroll run not found.")
  if (run.status !== "SUBMITTED") {
    throw new Error(
      "This run hasn't been submitted yet. Submit + approve the run before downloading files.",
    )
  }

  // PB ECP is the one kind where the user-supplied payment date is
  // part of the file CONTENT (Row 1) + filename (DDMMYY). Cache key
  // doesn't include date, so we sidestep the cache for this kind —
  // each click regenerates with the current admin-supplied date.
  // File size is small (low KBs) so re-rendering on every click is
  // cheap.
  const skipCacheRead = input.kind === "BANK_PB_ECP_XLSX"

  // Cache hit — return the existing entry without re-rendering.
  const cached = skipCacheRead
    ? null
    : await payrollRunReportRepository.getByRunAndKind({
        payrollRunId: run.id,
        kind: input.kind,
      })
  if (cached) {
    // The DB row claims the file exists, but the bytes live on disk
    // under public/uploads — and that can be wiped by a deploy or a
    // public/ cleanup while the row survives. If we trust the row
    // blindly we hand back a URL that 404s ("File wasn't available on
    // site") with no way to recover, since every retry re-returns the
    // same dead row. So verify the physical file is still there; only
    // short-circuit when it is. Otherwise fall through and re-render.
    const onDiskPath = path.join(
      process.cwd(),
      "public",
      cached.fileUrl.replace(/^\/+/, ""),
    )
    const fileExists = await access(onDiskPath).then(
      () => true,
      () => false,
    )
    if (fileExists) {
      return {
        fileName: cached.fileName,
        fileUrl: cached.fileUrl,
        mimeType: cached.mimeType,
        sizeBytes: cached.sizeBytes,
        alreadyCached: true,
      }
    }
  }

  // Cache miss — render the bytes via the matching renderer.
  const meta = PAYROLL_REPORT_META[input.kind]
  const generatedAt = new Date()
  let fileName = buildReportFileName({
    kind: input.kind,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    generatedAt,
  })
  // PB ECP filename is bank-spec'd (`<account>PR<DDMMYY><NN>.xlsx`).
  // Override the generic name with the proper PB filename so the
  // file the admin downloads is upload-ready into PB enterprise.
  // Payment date defaults to the last day of the period month when
  // the admin doesn't override it.
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
    paymentDate: resolvedPaymentDate,
  })

  // Persist to disk under public/uploads/payroll-reports/<runId>/.
  const uploadDir = path.join(
    process.cwd(),
    "public",
    "uploads",
    "payroll-reports",
    run.id,
  )
  await mkdir(uploadDir, { recursive: true })

  // Filesystem-safe filename based on the kind (not the
  // user-facing one) — the user-facing name is set via the
  // Content-Disposition header on download.
  const onDiskName = `${input.kind.toLowerCase()}.${meta.extension}`
  const onDiskPath = path.join(uploadDir, onDiskName)
  await writeFile(onDiskPath, bytes)

  const fileUrl = `/uploads/payroll-reports/${run.id}/${onDiskName}`
  const contentHash = createHash("sha256").update(bytes).digest("hex")

  await payrollRunReportRepository.upsert({
    payrollRunId: run.id,
    kind: input.kind,
    fileName,
    fileUrl,
    mimeType: meta.mimeType,
    sizeBytes: bytes.byteLength,
    contentHash,
  })

  // Bust the run-detail cache so the modal sees the new "generated"
  // state on its next load (the modal data is loaded inside the
  // run-detail server component).
  await bustPayrollCaches({ organizationId: orgId })

  return {
    fileName,
    fileUrl,
    mimeType: meta.mimeType,
    sizeBytes: bytes.byteLength,
    alreadyCached: false,
  }
}

/**
 * Read the bytes of one generated report so a route handler can stream
 * it back to the browser with a proper `Content-Disposition`.
 *
 * Why this exists: the files live under `public/uploads/...`, but
 * Next.js only serves files that were present in `public/` when the
 * server started — anything written at runtime (which is exactly how
 * these reports are produced) is NOT served by the static handler and
 * 404s ("File wasn't available on site"). So instead of linking the
 * browser straight at `/uploads/...`, we stream the bytes through an
 * admin route that reads them off disk here.
 *
 * Prefers the already-generated file on disk; if the row exists but the
 * bytes are gone (e.g. a deploy wiped `public/`), it falls back to
 * re-rendering via `generatePayrollReport`. Returns null when the
 * session/org doesn't match or the run/file can't be produced.
 */
export async function readPayrollReportFile(input: {
  runId: string
  kind: PayrollReportKind
}): Promise<{
  bytes: Buffer
  fileName: string
  mimeType: string
} | null> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: orgId,
  })
  if (!run) return null

  // Fast path — the row exists and the bytes are still on disk.
  const row = await payrollRunReportRepository.getByRunAndKind({
    payrollRunId: run.id,
    kind: input.kind,
  })
  if (row) {
    const onDiskPath = path.join(
      process.cwd(),
      "public",
      row.fileUrl.replace(/^\/+/, ""),
    )
    const bytes = await readFile(onDiskPath).then(
      (b) => b,
      () => null,
    )
    if (bytes) {
      return { bytes, fileName: row.fileName, mimeType: row.mimeType }
    }
  }

  // Missing on disk (or never generated) — re-render. This re-runs the
  // SUBMITTED gate + writes the file, then we read it straight back.
  const gen = await generatePayrollReport({
    runId: run.id,
    kind: input.kind,
  })
  const regenPath = path.join(
    process.cwd(),
    "public",
    gen.fileUrl.replace(/^\/+/, ""),
  )
  const bytes = await readFile(regenPath)
  return { bytes, fileName: gen.fileName, mimeType: gen.mimeType }
}

/// Parse a YYYY-MM-DD string into a Date at local midnight.
function parseIsoDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number)
  if (!y || !m || !d) return new Date()
  return new Date(y, m - 1, d)
}
