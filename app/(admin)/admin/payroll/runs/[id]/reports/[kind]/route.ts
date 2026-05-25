import { NextRequest, NextResponse } from "next/server"

import { readPayrollReportFile } from "@/modules/payroll/application/services/payroll-reports.service"
import {
  payrollReportKinds,
  type PayrollReportKind,
} from "@/modules/payroll/domain/reports"

/**
 * GET /admin/payroll/runs/[id]/reports/[kind]
 *
 * Streams one cached payroll report file (EPF CSV, SOCSO+EIS TXT,
 * PCB TXT, the PDFs, the PB ECP xlsx, …) back to the browser with a
 * `Content-Disposition: attachment` header.
 *
 * Why a route handler instead of linking `/uploads/...` directly:
 * Next.js only serves files that existed in `public/` at server start.
 * These reports are written at runtime, so the static handler 404s
 * them ("File wasn't available on site"). Reading the bytes here and
 * streaming them sidesteps static serving entirely.
 *
 * Auth: admin only, scoped to the active org inside the service.
 * Also behind the `/admin/:path*` middleware role gate.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  const { id, kind } = await params

  if (!payrollReportKinds.includes(kind as PayrollReportKind)) {
    return NextResponse.json({ error: "Unknown report kind." }, { status: 400 })
  }

  const file = await readPayrollReportFile({
    runId: id,
    kind: kind as PayrollReportKind,
  })

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
