import { NextResponse } from "next/server"

import { generateYtdImportTemplate } from "@/modules/payroll/application/services/payroll-ytd-import.service"

/**
 * GET /api/admin/payroll/ytd-import-template?year=YYYY
 *
 * Streams back the XLSX template the admin downloads from the Payroll
 * Runs page. The service handles session + role gating, so this route
 * is a thin pass-through that turns the buffer into a download.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const yearParam = url.searchParams.get("year")
  const year = yearParam ? Number(yearParam) : new Date().getFullYear()

  try {
    const { buffer, filename } = await generateYtdImportTemplate({ year })
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
    const message =
      err instanceof Error ? err.message : "Could not generate template."
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
