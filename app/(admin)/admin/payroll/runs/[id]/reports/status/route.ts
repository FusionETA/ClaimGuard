import { NextRequest, NextResponse } from "next/server"

import { getPayrollReportStatusRows } from "@/modules/payroll/application/services/payroll-reports.service"

/**
 * GET /admin/payroll/runs/[id]/reports/status
 *
 * Returns the current generation status for all report kinds on a run.
 * Bypasses Redis so the response reflects real-time state — used by the
 * downloads modal to poll for background pre-generation completing.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const rows = await getPayrollReportStatusRows({ runId: id })
  if (!rows) {
    return NextResponse.json({ error: "Not found." }, { status: 404 })
  }
  return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } })
}
