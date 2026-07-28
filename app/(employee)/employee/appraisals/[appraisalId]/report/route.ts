import { NextRequest, NextResponse } from "next/server"

import { getAppraisalReportPdfBytes } from "@/modules/appraisify/application/services/appraisal-report.service"

/**
 * GET /employee/appraisals/[appraisalId]/report
 *
 * Streams the completed appraisal's PDF report. Returns 404 when the caller
 * isn't a participant on this appraisal or the cycle hasn't reached SUBMITTED
 * yet — the service doesn't distinguish these cases in its response so the
 * route can't leak which one applied.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ appraisalId: string }> },
) {
  const { appraisalId } = await params
  const result = await getAppraisalReportPdfBytes(appraisalId)
  if (!result) {
    return NextResponse.json(
      { error: "Report not available." },
      { status: 404 },
    )
  }

  return new NextResponse(result.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "Cache-Control": "no-store",
    },
  })
}
