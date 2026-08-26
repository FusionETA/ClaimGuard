import { NextRequest, NextResponse } from "next/server"

import { safeErrorMessage } from "@/lib/errors"
import { readPayrollReportFile } from "@/modules/payroll/application/services/payroll-reports.service"
import {
  payrollReportKinds,
  type PayrollReportKind,
} from "@/modules/payroll/domain/reports"

/**
 * GET /admin/payroll/runs/[id]/reports/[kind]
 *     ?paymentDate=YYYY-MM-DD&recipientReference=...
 *
 * Renders one payroll report file (EPF CSV, SOCSO+EIS TXT, PCB TXT, the
 * PDFs, the PB ECP xlsx, …) ON DEMAND and streams it back to the browser
 * with a `Content-Disposition: attachment` header. Nothing is stored —
 * the bytes are produced fresh from the (Redis-cached) payroll data on
 * every request, so the statutory files always match the live run.
 *
 * `paymentDate` is consumed by the bank files (for PB ECP it also
 * shapes the filename). `recipientReference` is the mandatory
 * beneficiary reference on the Hong Leong formats — the admin types it
 * per payment, so it arrives per request rather than from settings.
 * Both are ignored by kinds that don't use them.
 *
 * Auth: admin only, scoped to the active org inside the service. Also
 * behind the `/admin/:path*` middleware role gate.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  const { id, kind } = await params

  if (!payrollReportKinds.includes(kind as PayrollReportKind)) {
    return NextResponse.json({ error: "Unknown report kind." }, { status: 400 })
  }

  const search = new URL(_req.url).searchParams
  const paymentDate = search.get("paymentDate") ?? undefined
  const recipientReference = search.get("recipientReference") ?? undefined

  let file: Awaited<ReturnType<typeof readPayrollReportFile>>
  try {
    file = await readPayrollReportFile({
      runId: id,
      kind: kind as PayrollReportKind,
      paymentDate,
      recipientReference,
    })
  } catch (err) {
    // A renderer can throw (e.g. payroll not run). Return a clean JSON
    // error so the modal can toast it instead of getting a raw 500.
    return NextResponse.json(
      { error: safeErrorMessage(err, "Could not generate this file.") },
      { status: 500 },
    )
  }

  if (!file) {
    return NextResponse.json(
      { error: "File not found, or the run hasn't been submitted yet." },
      { status: 404 },
    )
  }

  return new NextResponse(file.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Disposition": `attachment; filename="${sanitizeFileName(
        file.fileName,
      )}"`,
      // The underlying data changes whenever an admin regenerates or
      // edits payroll — never let a browser/CDN cache a stale copy.
      "Cache-Control": "no-store",
    },
  })
}

/// Strip characters that would break the Content-Disposition header.
function sanitizeFileName(name: string): string {
  return name.replace(/["\r\n]/g, "")
}
