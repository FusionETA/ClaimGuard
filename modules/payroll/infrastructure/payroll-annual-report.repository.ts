import "server-only"

import { unlink } from "node:fs/promises"
import path from "node:path"

import { getPrismaClient } from "@/lib/prisma"
import type { PayrollAnnualReportKind } from "@/modules/payroll/domain/annual-reports"

export type StoredPayrollAnnualReport = {
  id: string
  organizationId: string
  year: number
  kind: PayrollAnnualReportKind
  fileName: string
  fileUrl: string
  mimeType: string
  sizeBytes: number
  contentHash: string
  generatedAt: Date
}

/**
 * Persistence for the year-level annual report rows. Mirrors the
 * shape of `payrollRunReportRepository` for the per-run reports —
 * just keyed on `(organizationId, year)` instead of `runId`.
 */
export const payrollAnnualReportRepository = {
  async listForYear(input: {
    organizationId: string
    year: number
  }): Promise<StoredPayrollAnnualReport[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.payrollAnnualReport.findMany({
      where: { organizationId: input.organizationId, year: input.year },
      orderBy: { generatedAt: "asc" },
    })
    return rows.map(toStored)
  },

  async getByYearAndKind(input: {
    organizationId: string
    year: number
    kind: PayrollAnnualReportKind
  }): Promise<StoredPayrollAnnualReport | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.payrollAnnualReport.findUnique({
      where: {
        organizationId_year_kind: {
          organizationId: input.organizationId,
          year: input.year,
          kind: input.kind,
        },
      },
    })
    return row ? toStored(row) : null
  },

  async upsert(input: {
    organizationId: string
    year: number
    kind: PayrollAnnualReportKind
    fileName: string
    fileUrl: string
    mimeType: string
    sizeBytes: number
    contentHash: string
  }): Promise<StoredPayrollAnnualReport> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const row = await prisma.payrollAnnualReport.upsert({
      where: {
        organizationId_year_kind: {
          organizationId: input.organizationId,
          year: input.year,
          kind: input.kind,
        },
      },
      create: {
        organizationId: input.organizationId,
        year: input.year,
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
    return toStored(row)
  },

  /**
   * Drop every cached annual report for `(organizationId, year)`. Also
   * unlinks the files from disk. Called when any payroll run in the
   * given year transitions state (approve/revert/delete) so the next
   * generate sees the live SUBMITTED set.
   */
  async deleteForYear(input: {
    organizationId: string
    year: number
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return

    const rows = await prisma.payrollAnnualReport.findMany({
      where: { organizationId: input.organizationId, year: input.year },
      select: { fileUrl: true },
    })

    await Promise.all(
      rows.map(async (r) => {
        if (!r.fileUrl) return
        const relative = r.fileUrl.startsWith("/")
          ? r.fileUrl.slice(1)
          : r.fileUrl
        const absolute = path.join(process.cwd(), "public", relative)
        await unlink(absolute).catch(() => {
          /* swallow */
        })
      }),
    )

    await prisma.payrollAnnualReport.deleteMany({
      where: { organizationId: input.organizationId, year: input.year },
    })
  },
}

function toStored(row: {
  id: string
  organizationId: string
  year: number
  kind: string
  fileName: string
  fileUrl: string
  mimeType: string
  sizeBytes: number
  contentHash: string
  generatedAt: Date
}): StoredPayrollAnnualReport {
  return {
    id: row.id,
    organizationId: row.organizationId,
    year: row.year,
    kind: row.kind as PayrollAnnualReportKind,
    fileName: row.fileName,
    fileUrl: row.fileUrl,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    generatedAt: row.generatedAt,
  }
}
