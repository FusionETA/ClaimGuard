import "server-only"

import { sendEmail } from "@/modules/notifications/infrastructure/email"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import {
  buildPayslipFileName,
  renderEmployeePayslipPdf,
} from "@/modules/payroll/application/services/report-renderers/bulk-payslips-pdf"
import type { PayslipData } from "@/modules/payroll/domain/runs"
import { encryptPdf } from "@/modules/payroll/infrastructure/pdf-encrypt"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"

/**
 * Email statutory payslips to employees as a PASSWORD-PROTECTED PDF.
 * Manual, admin-triggered (per employee or a whole run) — never automatic,
 * so there's no accidental blast. Only SUBMITTED runs are emailable
 * (drafts aren't final).
 *
 * Each PDF is locked with the employee's IC number (falling back to their
 * date of birth as DDMMYYYY) so an intercepted or forwarded attachment
 * can't be opened by a stranger. A row with no email, or no IC/DOB to
 * lock with, fails cleanly and is reported back — nothing sensitive goes
 * out unprotected.
 */

export type PayslipEmailResult = {
  name: string
  email: string | null
  ok: boolean
  reason?: string
}

export type RunPayslipEmailSummary = {
  sent: number
  failed: number
  results: PayslipEmailResult[]
}

/** Derive the PDF open-password: IC number (digits/letters only), else
 *  date of birth as DDMMYYYY. Returns null when neither is on file. */
function derivePdfPassword(recipient: {
  idNumber: string | null
  dateOfBirth: Date | null
}): string | null {
  const ic = (recipient.idNumber ?? "").replace(/[^A-Za-z0-9]/g, "")
  if (ic.length > 0) return ic
  if (recipient.dateOfBirth) {
    const d = recipient.dateOfBirth
    const dd = String(d.getUTCDate()).padStart(2, "0")
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
    const yyyy = String(d.getUTCFullYear())
    return `${dd}${mm}${yyyy}`
  }
  return null
}

function periodLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-MY", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
}

function buildPayslipEmailHtml(input: {
  name: string
  organizationName: string
  period: string
}): string {
  const name = input.name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  const org = input.organizationName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; padding: 32px 16px;">
      <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 32px;">
        <h1 style="margin: 0 0 8px; font-size: 20px; color: #18181b;">Your payslip — ${input.period}</h1>
        <p style="margin: 0 0 16px; color: #52525b; font-size: 14px; line-height: 1.5;">
          Hi ${name}, your payslip from ${org} for ${input.period} is attached as a PDF.
        </p>
        <div style="background: #f4f4f5; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
          <p style="margin: 0; color: #3f3f46; font-size: 13px; line-height: 1.5;">
            The PDF is <strong>password-protected</strong>. Open it with your
            <strong>IC number</strong> (no dashes or spaces). If you don't have
            an IC on file, use your <strong>date of birth</strong> as DDMMYYYY.
          </p>
        </div>
        <p style="margin: 0; color: #a1a1aa; font-size: 13px;">
          Please keep this document confidential.
        </p>
      </div>
    </div>
  `
}

/**
 * Render + encrypt + send one payslip. Shared by the single and bulk
 * paths so they behave identically. Never throws — returns a structured
 * result the action can surface per recipient.
 */
async function sendOnePayslip(input: {
  payslip: PayslipData
  periodYear: number
  periodMonth: number
  organizationName: string
}): Promise<PayslipEmailResult> {
  const { payslip, periodYear, periodMonth, organizationName } = input
  const label = payslip.snapshotName || payslip.snapshotEmployeeId || "Employee"
  try {
    const recipient = await payslipRepository.getEmailRecipientForProfile({
      employeeProfileId: payslip.employeeProfileId,
    })
    if (!recipient || !recipient.email) {
      return { name: label, email: null, ok: false, reason: "No email on file." }
    }

    const password = derivePdfPassword(recipient)
    if (!password) {
      return {
        name: label,
        email: recipient.email,
        ok: false,
        reason: "No IC number or date of birth to lock the PDF with.",
      }
    }

    const pdf = await renderEmployeePayslipPdf({
      organizationName,
      periodYear,
      periodMonth,
      payslip,
    })
    const encrypted = await encryptPdf(pdf, password)

    const periodTag = `${String(periodMonth).padStart(2, "0")}-${periodYear}`
    const fileName = buildPayslipFileName({
      employeeId: payslip.snapshotEmployeeId,
      employeeName: payslip.snapshotName,
      periodTag,
    })

    const result = await sendEmail({
      to: recipient.email,
      subject: `Your payslip — ${periodLabel(periodYear, periodMonth)}`,
      html: buildPayslipEmailHtml({
        name: recipient.name,
        organizationName,
        period: periodLabel(periodYear, periodMonth),
      }),
      attachments: [
        { filename: fileName, contentBase64: encrypted.toString("base64") },
      ],
    })

    return {
      name: label,
      email: recipient.email,
      ok: result.delivered,
      reason: result.delivered ? undefined : result.reason,
    }
  } catch (err) {
    return {
      name: label,
      email: null,
      ok: false,
      reason: err instanceof Error ? err.message : "Failed to send.",
    }
  }
}

/** Email a single payslip to its employee. */
export async function emailPayslip(input: {
  organizationId: string
  payslipId: string
}): Promise<PayslipEmailResult> {
  const payslip = await payslipRepository.getByIdForOrg({
    payslipId: input.payslipId,
    organizationId: input.organizationId,
  })
  if (!payslip) {
    return { name: "Employee", email: null, ok: false, reason: "Payslip not found." }
  }
  const run = await payrollRunRepository.getByIdForOrg({
    id: payslip.payrollRunId,
    organizationId: input.organizationId,
  })
  if (!run || run.status !== "SUBMITTED") {
    return {
      name: payslip.snapshotName,
      email: null,
      ok: false,
      reason: "Payslips can only be emailed once the run is submitted.",
    }
  }
  const org = await organizationRepository.getOrganizationById(input.organizationId)
  return sendOnePayslip({
    payslip,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    organizationName: org?.name ?? "",
  })
}

/** Email every payslip on a submitted run to its employee. */
export async function emailPayslipsForRun(input: {
  organizationId: string
  runId: string
}): Promise<RunPayslipEmailSummary> {
  const run = await payrollRunRepository.getByIdForOrg({
    id: input.runId,
    organizationId: input.organizationId,
  })
  if (!run || run.status !== "SUBMITTED") {
    return {
      sent: 0,
      failed: 0,
      results: [
        {
          name: "—",
          email: null,
          ok: false,
          reason: "Payslips can only be emailed once the run is submitted.",
        },
      ],
    }
  }
  const org = await organizationRepository.getOrganizationById(input.organizationId)
  const organizationName = org?.name ?? ""
  const payslips = await payslipRepository.listForRun(input.runId)

  const results: PayslipEmailResult[] = []
  // Sequential on purpose — each send renders + encrypts a PDF (CPU) and
  // hits the provider; a burst of parallel encrypts on a small droplet
  // would spike memory and risk provider rate limits.
  for (const payslip of payslips) {
    results.push(
      await sendOnePayslip({
        payslip,
        periodYear: run.periodYear,
        periodMonth: run.periodMonth,
        organizationName,
      }),
    )
  }

  const sent = results.filter((r) => r.ok).length
  return { sent, failed: results.length - sent, results }
}
