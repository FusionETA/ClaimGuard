import "server-only"

import { unlink } from "node:fs/promises"
import path from "node:path"

import { getPrismaClient } from "@/lib/prisma"
import type { PayrollReportKind } from "@/modules/payroll/domain/reports"

/**
 * Persistence for the per-run cached report rows. Mirrors the shape
 * the modal needs.
 *
 * Per-aggregate Prisma access rule applies — all `payrollRunReport`
 * queries go through this file.
 */
export type StoredPayrollReport = {
  id: string
  payrollRunId: string
  kind: PayrollReportKind
  fileName: string
  fileUrl: string
  mimeType: string
  sizeBytes: number
  contentHash: string
  generatedAt: Date
}

export const payrollRunReportRepository = {
  async listForRun(payrollRunId: string): Promise<StoredPayrollReport[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.payrollRunReport.findMany({
      where: { payrollRunId },
      orderBy: { generatedAt: "asc" },
    })
    return rows.map((r) => ({
      id: r.id,
      payrollRunId: r.payrollRunId,
      kind: r.kind as PayrollReportKind,
      fileName: r.fileName,
      fileUrl: r.fileUrl,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      contentHash: r.contentHash,
      generatedAt: r.generatedAt,
    }))
  },

  async getByRunAndKind(input: {
    payrollRunId: string
    kind: PayrollReportKind
  }): Promise<StoredPayrollReport | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.payrollRunReport.findUnique({
      where: {
        payrollRunId_kind: {
          payrollRunId: input.payrollRunId,
          kind: input.kind,
        },
      },
    })
    if (!row) return null
    return {
      id: row.id,
      payrollRunId: row.payrollRunId,
      kind: row.kind as PayrollReportKind,
      fileName: row.fileName,
      fileUrl: row.fileUrl,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      contentHash: row.contentHash,
      generatedAt: row.generatedAt,
    }
  },

  /**
   * Insert-or-replace by `(payrollRunId, kind)`. Existing rows for the
   * same kind get overwritten — the modal only ever shows the latest
   * generation per kind.
   */
  async upsert(input: {
    payrollRunId: string
    kind: PayrollReportKind
    fileName: string
    fileUrl: string
    mimeType: string
    sizeBytes: number
    contentHash: string
  }): Promise<StoredPayrollReport> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const row = await prisma.payrollRunReport.upsert({
      where: {
        payrollRunId_kind: {
          payrollRunId: input.payrollRunId,
          kind: input.kind,
        },
      },
      create: {
        payrollRunId: input.payrollRunId,
        kind: input.kind,
        fileName: input.fileName,
        fileUrl: input.fileUrl,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        contentHash: input.contentHash,
      },
      update: {
        fileName: input.fileName,
        fileUrl: input.fileUrl,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        contentHash: input.contentHash,
        generatedAt: new Date(),
      },
    })
    return {
      id: row.id,
      payrollRunId: row.payrollRunId,
      kind: row.kind as PayrollReportKind,
      fileName: row.fileName,
      fileUrl: row.fileUrl,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      contentHash: row.contentHash,
      generatedAt: row.generatedAt,
    }
  },

  /**
   * Delete every report row for a run AND remove the underlying files
   * from disk. Called from `revertPayrollRunToDraft` so the next
   * re-submit starts with fresh, regenerated files. Cascades on run
   * deletion via the Prisma FK; this path covers the soft "revert"
   * case where the run row stays around.
   */
  async deleteForRun(payrollRunId: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return

    const rows = await prisma.payrollRunReport.findMany({
      where: { payrollRunId },
      select: { fileUrl: true },
    })

    // Try to unlink each file on disk. Swallow errors — a missing file
    // shouldn't block the DB delete.
    await Promise.all(
      rows.map(async (r) => {
        if (!r.fileUrl) return
        // `fileUrl` is `/uploads/...` — resolve under `public/`.
        const relative = r.fileUrl.startsWith("/")
          ? r.fileUrl.slice(1)
          : r.fileUrl
        const absolute = path.join(process.cwd(), "public", relative)
        await unlink(absolute).catch(() => {
          /* swallow */
        })
      }),
    )

    await prisma.payrollRunReport.deleteMany({
      where: { payrollRunId },
    })
  },
}
