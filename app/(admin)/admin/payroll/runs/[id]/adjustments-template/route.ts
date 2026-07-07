import { NextResponse } from "next/server"

import { safeErrorMessage } from "@/lib/errors"
import { generateAdjustmentImportTemplate } from "@/modules/payroll/application/services/payroll-run-adjustment-import.service"

/**
 * GET /admin/payroll/runs/[id]/adjustments-template
 *
 * Streams an XLSX template pre-populated with the run's eligible
 * employees, ready for the admin to fill in categories + amounts and
 * upload back through the import dialog. Session + role checked in
 * the underlying service.
 */
export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const { buffer, filename } = await generateAdjustmentImportTemplate({
      runId: id,
    })
    // Wrap the Node Buffer in a Uint8Array — Next.js's fetch-style
    // NextResponse constructor accepts BodyInit, which includes
    // ArrayBufferView. Passing a raw Node Buffer works but the
    // narrower type helps the type-checker stay happy across Next
    // versions.
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    return NextResponse.json(
      {
        error: safeErrorMessage(err, "Could not generate the template."),
      },
      { status: 400 },
    )
  }
}
