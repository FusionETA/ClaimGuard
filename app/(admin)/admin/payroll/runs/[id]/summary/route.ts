import { NextResponse } from "next/server"

import { getPayrollRunDetailWithPayslipsPageData } from "@/modules/payroll/application/services/payroll-run.service"
import {
  periodKey,
  periodLabel,
  type PayslipRow,
} from "@/modules/payroll/domain/runs"

export const runtime = "nodejs"

type TextRun = {
  text: string
  x: number
  y: number
  size: number
  bold?: boolean
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const data = await getPayrollRunDetailWithPayslipsPageData({ runId: id })

  if (!data) {
    return NextResponse.json({ error: "Payroll run not found." }, { status: 404 })
  }

  if (data.payslips.length === 0) {
    return NextResponse.json(
      { error: "Run payroll before downloading the summary PDF." },
      { status: 409 },
    )
  }

  const period = periodLabel(data.run.periodYear, data.run.periodMonth)
  const filename = `payroll-summary-${periodKey(
    data.run.periodYear,
    data.run.periodMonth,
  )}.pdf`

  const pdf = buildPayrollSummaryPdf({
    organizationName: data.organizationName,
    period,
    status: data.run.status,
    generatedAt: new Date(),
    totals: [
      ["Employees", String(data.run.employeeCount ?? data.payslips.length)],
      ["Gross pay", formatMyr(data.run.totalGross)],
      ["Net pay", formatMyr(data.run.totalNet)],
      ["Employee EPF", formatMyr(data.run.totalEmployeeEpf)],
      ["Employer EPF", formatMyr(data.run.totalEmployerEpf)],
      ["Employee SOCSO", formatMyr(data.run.totalEmployeeSocso)],
      ["Employer SOCSO", formatMyr(data.run.totalEmployerSocso)],
      ["Employee EIS", formatMyr(data.run.totalEmployeeEis)],
      ["Employer EIS", formatMyr(data.run.totalEmployerEis)],
      ["PCB", formatMyr(data.run.totalPcb)],
      ["HRDF", formatMyr(data.run.totalHrdf)],
      ["Total cost to employer", formatMyr(data.run.totalCostToEmployer)],
    ],
    payslips: data.payslips,
  })

  return new NextResponse(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}

function buildPayrollSummaryPdf(input: {
  organizationName: string
  period: string
  status: string
  generatedAt: Date
  totals: Array<[string, string]>
  payslips: PayslipRow[]
}) {
  const pages: TextRun[][] = [[]]
  let y = 780

  function page() {
    return pages[pages.length - 1]
  }

  function ensureSpace(height = 20) {
    if (y - height >= 50) return
    pages.push([])
    y = 780
  }

  function addText(
    text: string,
    x: number,
    options: { size?: number; bold?: boolean; advance?: number } = {},
  ) {
    ensureSpace(options.advance ?? 18)
    page().push({
      text,
      x,
      y,
      size: options.size ?? 10,
      bold: options.bold,
    })
  }

  function nextLine(amount = 18) {
    y -= amount
  }

  addText(`Payroll Summary - ${input.period}`, 50, { size: 18, bold: true })
  nextLine(24)
  addText(input.organizationName || "Organization", 50, { size: 12, bold: true })
  nextLine()
  addText(`Status: ${input.status}`, 50)
  addText(`Generated: ${input.generatedAt.toLocaleString()}`, 290)
  nextLine(30)

  addText("Run totals", 50, { size: 13, bold: true })
  nextLine(22)
  for (let i = 0; i < input.totals.length; i += 2) {
    const left = input.totals[i]
    const right = input.totals[i + 1]
    addText(left[0], 50, { bold: true })
    addText(left[1], 190)
    if (right) {
      addText(right[0], 310, { bold: true })
      addText(right[1], 470)
    }
    nextLine()
  }

  nextLine(12)
  addText("Employee breakdown", 50, { size: 13, bold: true })
  nextLine(24)
  addEmployeeHeader()

  for (const payslip of input.payslips) {
    ensureSpace(22)
    addText(truncate(payslip.snapshotEmployeeId, 10), 50, { size: 9 })
    addText(truncate(payslip.snapshotName, 24), 120, { size: 9, bold: true })
    addText(formatMyr(payslip.grossPay), 285, { size: 9 })
    addText(formatMyr(payslip.netPay), 370, { size: 9 })
    addText(formatMyr(payslip.epfEmployee), 455, { size: 9 })
    addText(formatMyr(payslip.pcb), 525, { size: 9 })
    nextLine(18)
  }

  function addEmployeeHeader() {
    ensureSpace(22)
    addText("ID", 50, { size: 9, bold: true })
    addText("Employee", 120, { size: 9, bold: true })
    addText("Gross", 285, { size: 9, bold: true })
    addText("Net", 370, { size: 9, bold: true })
    addText("EPF", 455, { size: 9, bold: true })
    addText("PCB", 525, { size: 9, bold: true })
    nextLine(18)
  }

  return writePdf(pages)
}

function writePdf(pages: TextRun[][]) {
  const objects: string[] = ["", ""]
  const pageIds: number[] = []

  function addObject(body: string) {
    objects.push(body)
    return objects.length
  }

  for (const runs of pages) {
    const content = runs.map(textRunToPdf).join("\n")
    const contentId = addObject(
      `<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream`,
    )
    const pageId = addObject(
      [
        "<< /Type /Page",
        "/Parent 2 0 R",
        "/MediaBox [0 0 595 842]",
        "/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> >> >>",
        `/Contents ${contentId} 0 R >>`,
      ].join(" "),
    )
    pageIds.push(pageId)
  }

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>"
  objects[1] = `<< /Type /Pages /Kids [${pageIds
    .map((id) => `${id} 0 R`)
    .join(" ")}] /Count ${pageIds.length} >>`

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"
  const offsets = [0]
  objects.forEach((body, index) => {
    offsets.push(byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefOffset = byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += "0000000000 65535 f \n"
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, "binary")
}

function textRunToPdf(run: TextRun) {
  const font = run.bold ? "F2" : "F1"
  return `BT /${font} ${run.size} Tf ${run.x} ${run.y} Td (${escapePdfText(
    ascii(run.text),
  )}) Tj ET`
}

function escapePdfText(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
}

function ascii(text: string) {
  return text.replace(/[^\x20-\x7E]/g, " ")
}

function byteLength(text: string) {
  return Buffer.byteLength(text, "binary")
}

function truncate(text: string | null | undefined, max: number) {
  const value = text?.trim() || "-"
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 3))}...`
}

function formatMyr(value: number | null | undefined) {
  if (value == null) return "MYR 0.00"
  return `MYR ${value.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
