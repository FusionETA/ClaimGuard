import { NextRequest, NextResponse } from "next/server"

import {
  dailyExportFilename,
  generateDailyAttendanceExcel,
  generateDailyAttendancePdf,
} from "@/modules/attendance/application/services/attendance-daily-export.service"

import { resolveDailyExportRequest } from "./params"

/**
 * Day-by-day attendance export — one page (PDF) or sheet (Excel) per day,
 * listing every employee in the admin's project/team filter.
 *
 * `?format=xlsx` switches renderer; both share the same data builder so
 * the two downloads always agree.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const resolved = await resolveDailyExportRequest(url)
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  }

  const excel = url.searchParams.get("format") === "xlsx"

  try {
    const buffer = excel
      ? await generateDailyAttendanceExcel(resolved)
      : await generateDailyAttendancePdf(resolved)

    const filename = dailyExportFilename(
      resolved.from,
      resolved.to,
      excel ? "xlsx" : "pdf",
    )
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": excel
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate report."
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
