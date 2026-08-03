import { NextRequest, NextResponse } from "next/server"

import { safeErrorMessage } from "@/lib/errors"
import { readPayrollAnnualReportFile } from "@/modules/payroll/application/services/payroll-annual-reports.service"
import {
  payrollAnnualReportKinds,
  type PayrollAnnualReportKind,
} from "@/modules/payroll/domain/annual-reports"

/**
 * GET /admin/payroll/annual-forms/[year]/[kind]
 *
 * Renders one annual tax form (Form EA bulk PDF, Form E + CP8D PDF, the
 * two CP8D TXT files) ON DEMAND and streams it back with a
 * `Content-Disposition: attachment` header. Nothing is stored — the
 * bytes are produced fresh from the live SUBMITTED runs on every
 * request.
 *
 * Gated (inside the service) on the complete Jan-Dec set of SUBMITTED
 * runs for the year. Auth: admin only, scoped to the active org. Also
 * behind the `/admin/:path*` middleware role gate.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ year: string; kind: string }> },
) {
  const { year, kind } = await params

  if (!payrollAnnualReportKinds.includes(kind as PayrollAnnualReportKind)) {
    return NextResponse.json({ error: "Unknown report kind." }, { status: 400 })
  }

  const parsedYear = Number(year)
  if (!Number.isInteger(parsedYear) || parsedYear < 1900) {
    return NextResponse.json({ error: "Invalid year." }, { status: 400 })
  }

  let file: Awaited<ReturnType<typeof readPayrollAnnualReportFile>>
  try {
    file = await readPayrollAnnualReportFile({
      year: parsedYear,
      kind: kind as PayrollAnnualReportKind,
    })
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err, "Could not generate this file.") },
      { status: 500 },
    )
  }

  if (!file) {
    return NextResponse.json(
      {
        error:
          "File not available — every Jan-Dec payroll run for this year must be approved first.",
      },
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
      "Cache-Control": "no-store",
    },
  })
}

/// Strip characters that would break the Content-Disposition header.
function sanitizeFileName(name: string): string {
  return name.replace(/["\r\n]/g, "")
}
