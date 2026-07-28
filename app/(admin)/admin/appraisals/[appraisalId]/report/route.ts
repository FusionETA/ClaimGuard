import { NextRequest, NextResponse } from "next/server"

import { getAdminAppraisalReportPdfBytes } from "@/modules/appraisify/application/services/appraisal-report.service"

/**
 * GET /admin/appraisals/[appraisalId]/report
 *
 * Admin-side PDF download — any org admin, not just a participant. Behind
 * the `/admin/:path*` middleware role gate; org-scoping happens inside the
 * service. Returns 404 when the appraisal doesn't exist in this org or
 * hasn't reached SUBMITTED yet.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ appraisalId: string }> },
) {
  const { appraisalId } = await params
  const result = await getAdminAppraisalReportPdfBytes(appraisalId)
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
