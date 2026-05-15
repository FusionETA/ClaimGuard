import { renderToStream } from "@react-pdf/renderer"
import { NextResponse } from "next/server"

import { PayrollSummaryPdfDocument } from "@/components/admin/payroll-summary-pdf-document"
import { getPayrollRunDetailWithPayslipsPageData } from "@/modules/payroll/application/services/payroll-run.service"
import { periodKey, periodLabel } from "@/modules/payroll/domain/runs"

/**
 * Streams a properly-laid-out PDF of the run's payroll summary —
 * built server-side with `@react-pdf/renderer`, NOT a screenshot of
 * the admin page.
 *
 * Filename: `<org>-payroll-<YYYY-MM>.pdf` (filesystem-safe), with a
 * human-readable `filename*` for the browser's Save dialog so
 * non-ASCII org names render correctly.
 */
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const data = await getPayrollRunDetailWithPayslipsPageData({ runId: id })

  if (!data) {
    return NextResponse.json(
      { error: "Payroll run not found." },
      { status: 404 },
    )
  }

  if (data.payslips.length === 0) {
    return NextResponse.json(
      { error: "Run payroll before downloading the summary PDF." },
      { status: 409 },
    )
  }

  const period = periodLabel(data.run.periodYear, data.run.periodMonth)

  // Filesystem-safe ASCII fallback for the Content-Disposition's
  // legacy `filename` parameter. Strip non-ASCII (e.g. "&" "—" etc.)
  // and collapse spaces to hyphens — most older clients use this.
  const ascii = `${data.organizationName} Payroll ${period}`
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 80)
  const safeFilename = `${ascii || "payroll-summary"}.pdf`

  // RFC 5987 / 6266 encoded filename so browsers can use the real
  // human-readable name with month + year in the saved-as dialog.
  const humanName = `${data.organizationName} Payroll ${period}.pdf`
  const encodedHuman = encodeURIComponent(humanName)

  // `renderToStream` returns a Node.js Readable. We pipe it through
  // a small adapter into a Web ReadableStream so the Next.js Edge
  // / Node runtime can hand it back as a Response body. The PDF
  // bytes stream out as they're generated rather than buffering the
  // whole document in memory.
  const nodeStream = await renderToStream(
    <PayrollSummaryPdfDocument
      organizationName={data.organizationName}
      period={period}
      payslips={data.payslips}
      generatedAt={new Date()}
    />,
  )

  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
      })
      nodeStream.on("end", () => controller.close())
      nodeStream.on("error", (err: Error) => controller.error(err))
    },
    cancel() {
      // The type returned by `@react-pdf/renderer.renderToStream` is
      // the legacy NodeJS.ReadableStream which doesn't expose
      // `destroy()` on its public type — but the runtime value is
      // a real Readable that does. Cast through `unknown` to call
      // it without crashing TS.
      const r = nodeStream as unknown as { destroy?: () => void }
      r.destroy?.()
    },
  })

  // Convenience query flag `?download=1` forces the browser to
  // treat the response as a download instead of rendering inline.
  // Without it the PDF opens in a new tab.
  const url = new URL(_request.url)
  const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline"

  // Cache-key on run id + period so two views of the same run hit
  // the same edge cache slot if any is configured upstream. We
  // still mark Cache-Control: private so individual cells don't
  // share with other admins.
  const periodTag = periodKey(data.run.periodYear, data.run.periodMonth)

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${safeFilename}"; filename*=UTF-8''${encodedHuman.replace(/'/g, "%27")}`,
      "Cache-Control": "private, no-store",
      "X-Payroll-Run": id,
      "X-Payroll-Period": periodTag,
    },
  })
}
