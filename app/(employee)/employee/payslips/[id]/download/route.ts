import { NextRequest, NextResponse } from "next/server"

import { getEmployeePayslipPdfBytes } from "@/modules/payroll/application/services/employee-payroll.service"

/**
 * GET /employee/payslips/[id]/download
 *
 * Renders the employee's individual payslip PDF ON DEMAND and streams it
 * back. Nothing is stored — the PDF is produced fresh from the payslip
 * snapshot each time. Returns 404 when the caller doesn't own the
 * payslip or the run isn't SUBMITTED (drafts are admin-only).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const result = await getEmployeePayslipPdfBytes({ payslipId: id })
  if (!result) {
    return NextResponse.json(
      { error: "Payslip PDF not available yet." },
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
