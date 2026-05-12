import { NextRequest, NextResponse } from "next/server"

import {
  getPayrollDisbursementRows,
  type DisbursementRow,
} from "@/modules/payroll/application/services/payroll-run.service"
import { periodKey } from "@/modules/payroll/domain/runs"

/**
 * GET /admin/payroll/runs/[id]/disbursement
 *
 * Streams a CSV of bank-disbursement rows for the run. Universal
 * column shape — admins paste these into their bank's bulk-transfer
 * template (Maybank2u Biz, CIMB BizChannel, RHB Reflex) or upload
 * directly if their bank accepts generic CSV.
 *
 * Auth: admin only, scoped to the active org via the service.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const data = await getPayrollDisbursementRows({ runId: id })

  if (!data) {
    return NextResponse.json(
      { error: "Payroll run not found or not in your organisation." },
      { status: 404 },
    )
  }

  const csv = buildCsv(data.rows)
  const filename = `payroll-disbursement-${periodKey(
    data.run.periodYear,
    data.run.periodMonth,
  )}.csv`

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Disable browser/CDN caching — the underlying data changes
      // whenever an admin regenerates or edits payroll.
      "Cache-Control": "no-store",
    },
  })
}

const HEADERS = [
  "Sequence",
  "Employee Code",
  "Employee Name",
  "Bank",
  "Account Holder Name",
  "Account Number",
  "Currency",
  "Net Amount",
  "Reference",
] as const

function buildCsv(rows: DisbursementRow[]): string {
  const lines = [HEADERS.join(",")]
  for (const r of rows) {
    lines.push(
      [
        String(r.sequence),
        csvField(r.employeeCode),
        csvField(r.employeeName),
        csvField(r.bankName),
        csvField(r.accountHolderName),
        // Wrap account number in quotes — long numerics otherwise get
        // mangled into scientific notation by Excel on open.
        `="${escape(r.accountNumber)}"`,
        csvField(r.currency),
        r.netAmount.toFixed(2),
        csvField(r.reference),
      ].join(","),
    )
  }
  // BOM for Excel UTF-8 friendliness.
  return "﻿" + lines.join("\r\n") + "\r\n"
}

function csvField(value: string): string {
  // Quote if the field contains comma, quote, or newline; double-up
  // embedded quotes per RFC 4180.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function escape(value: string): string {
  return value.replace(/"/g, '""')
}
