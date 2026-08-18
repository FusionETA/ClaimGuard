import "server-only"

import { findBankByName } from "@/modules/payroll/domain/malaysian-banks"
import { getPayrollDisbursementRowsForOrg } from "@/modules/payroll/application/services/payroll-run.service"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"

/**
 * General (bank-agnostic) salary-disbursement CSV — offered when the
 * company's payroll bank is NOT Public Bank (the PB ECP XLSX covers
 * that case with its own strict format). A clean, common column layout
 * most banks accept or can map when keying a bulk payroll batch:
 *   Payee Name · Bank · BIC · Account No · Amount (RM) · Reference
 * The payor details (bank, account, holder, org code) are echoed in a
 * `#`-comment header block so the admin has them to hand.
 */

function csvField(v: string | number): string {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function renderBankGeneralCsv(input: {
  runId: string
  organizationId: string
}): Promise<Buffer> {
  const orgId = input.organizationId
  const [settings, data] = await Promise.all([
    payrollSettingsRepository.getByOrgId(orgId),
    getPayrollDisbursementRowsForOrg({ runId: input.runId, organizationId: orgId }),
  ])
  if (!data) throw new Error("Payroll run not found.")

  const period = `${String(data.run.periodMonth).padStart(2, "0")}/${data.run.periodYear}`
  const reference = `Salary ${period}`.slice(0, 20)

  const lines: string[] = []
  lines.push(`# Payroll disbursement - ${data.organizationName} - ${period}`)
  if (settings?.payrollBankName) lines.push(`# Payor bank: ${settings.payrollBankName}`)
  if (settings?.ecpPayorAccountNo) lines.push(`# Payor account: ${settings.ecpPayorAccountNo}`)
  if (settings?.payorAccountHolderName)
    lines.push(`# Payor account holder: ${settings.payorAccountHolderName}`)
  if (settings?.payorOrganisationCode)
    lines.push(`# Organisation code: ${settings.payorOrganisationCode}`)
  lines.push(
    ["Payee Name", "Bank", "BIC", "Account No", "Amount (RM)", "Reference"].join(","),
  )

  let count = 0
  for (const row of data.rows) {
    if (!row.accountNumber || row.accountNumber.trim().length === 0) continue
    if (row.netAmount <= 0) continue
    const bank = findBankByName(row.bankName)
    lines.push(
      [
        csvField(row.accountHolderName || row.employeeName),
        csvField(row.bankName ?? bank?.name ?? ""),
        csvField(bank?.bic ?? ""),
        csvField(row.accountNumber.replace(/[^0-9]/g, "")),
        csvField(row.netAmount.toFixed(2)),
        csvField(reference),
      ].join(","),
    )
    count += 1
  }

  if (count === 0) {
    throw new Error(
      "No employees on this run have a bank account number to disburse to. Add bank details on their payroll profiles first.",
    )
  }

  return Buffer.from(lines.join("\r\n") + "\r\n", "utf-8")
}
