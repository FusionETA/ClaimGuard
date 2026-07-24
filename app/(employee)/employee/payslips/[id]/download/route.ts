import { NextRequest, NextResponse } from "next/server"

import { getEmployeePayslipPdfBytes } from "@/modules/payroll/application/services/employee-payroll.service"

/**
 * GET /employee/payslips/[id]/download
 *
 * Streams the employee's individual payslip PDF extracted from the
 * pre-generated bulk payslips ZIP. Returns 404 when the ZIP hasn't been
 * generated yet (admin hasn't approved the run, or pre-gen is still in
 * progress).
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
