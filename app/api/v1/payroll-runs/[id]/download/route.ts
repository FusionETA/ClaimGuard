import { NextResponse } from "next/server"
import JSZip from "jszip"

import { handleApiRequest } from "@/lib/api-auth"
import { renderPayrollReportFileForOrg } from "@/modules/payroll/application/services/payroll-reports.service"
import {
  PAYROLL_FILE_FORMAT_TO_KIND,
  type PayrollReportKind,
} from "@/modules/payroll/domain/reports"
import { resolvePayrollFileFormat } from "@/modules/payroll/domain/malaysian-banks"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"

/**
 * GET /api/v1/payroll-runs/[id]/download?paymentDate=YYYY-MM-DD
 *
 * Required scope: `payroll:read`.
 *
 * Streams a ZIP bundle of a submitted run's disbursement + statutory
 * files so an external system (e.g. the ABPay importer) can pull
 * everything it needs after approving the run — without an admin logging
 * into AltomateHR.
 *
 * The bundle contains the bank payment file, the payslips, a summary PDF,
 * and the three statutory upload files. Each file is rendered ON DEMAND
 * from the live run (nothing is stored), reusing the same generator the
 * in-app downloads modal uses.
 *
 * Security model (per design): the endpoint itself is the gate —
 *   - Bearer token auth (`payroll:read` scope) + HTTPS,
 *   - the token is org-scoped, and `getByIdForOrg` returns null for a run
 *     in another org, so one tenant can never pull another's files,
 *   - only SUBMITTED runs are downloadable (drafts → 409).
 * The zip itself is NOT password-protected (a direct download, as agreed);
 * add encryption at the zip layer later if the file needs at-rest
 * protection on the caller's side.
 *
 * `paymentDate` (optional, ISO YYYY-MM-DD) only affects the bank PB ECP
 * file's content + filename; it defaults to the last day of the period.
 */

// The disbursement bundle: payslips, a run summary, and the three
// statutory upload files. The bank payment file is resolved per-org at
// request time (each bank has its own format) and prepended below. A
// kind that can't be rendered for this run (e.g. bank settings missing)
// is skipped rather than failing the whole bundle — see the try/catch
// in the loop.
const BUNDLE_KINDS: PayrollReportKind[] = [
  "PAYROLL_SUMMARY_PDF",
  "BULK_PAYSLIPS_PDF",
  "EPF_CSV",
  "SOCSO_EIS_TXT",
  "PCB_TXT",
]

export const GET = handleApiRequest<{ id: string }>(
  ["payroll:read"],
  async (request, ctx) => {
    const { id } = ctx.params
    const organizationId = ctx.integration.organizationId

    const run = await payrollRunRepository.getByIdForOrg({ id, organizationId })
    if (!run) {
      return NextResponse.json(
        { error: { status: 404, message: "Payroll run not found." } },
        { status: 404 },
      )
    }
    if (run.status !== "SUBMITTED") {
      return NextResponse.json(
        {
          error: {
            status: 409,
            message:
              "Run is not submitted yet — approve it before downloading its files.",
          },
        },
        { status: 409 },
      )
    }

    const paymentDate =
      new URL(request.url).searchParams.get("paymentDate") ?? undefined

    // Prepend the bank file matching THIS org's payroll bank. Omitted
    // when no disbursement bank is configured — the rest of the bundle
    // still renders.
    const settings = await payrollSettingsRepository.getByOrgId(organizationId)
    const bankFormat = resolvePayrollFileFormat(settings?.payrollBankName)
    const kinds: PayrollReportKind[] = bankFormat
      ? [PAYROLL_FILE_FORMAT_TO_KIND[bankFormat], ...BUNDLE_KINDS]
      : BUNDLE_KINDS

    const zip = new JSZip()
    const included: string[] = []
    const skipped: Array<{ kind: PayrollReportKind; reason: string }> = []
    for (const kind of kinds) {
      try {
        const file = await renderPayrollReportFileForOrg({
          runId: id,
          kind,
          organizationId,
          paymentDate,
        })
        if (file) {
          zip.file(file.fileName, file.bytes)
          included.push(file.fileName)
        } else {
          skipped.push({
            kind,
            reason: "Renderer returned no file (run not submitted or no data).",
          })
        }
      } catch (err) {
        // A single renderer can throw (e.g. no bank account configured).
        // Skip just that file so the caller still gets the rest — but keep
        // the reason so it can be surfaced instead of silently swallowed.
        const reason = err instanceof Error ? err.message : String(err)
        skipped.push({ kind, reason })
        console.error(
          `[api/v1] payroll download: skipped ${kind} for run ${id}:`,
          err,
        )
      }
    }

    if (included.length === 0) {
      // Return the collected per-file reasons so the caller can tell
      // "not configured" from an auth / rendering fault, instead of a
      // generic string that hides which renderers failed and why.
      return NextResponse.json(
        {
          error: {
            status: 422,
            message: "No files could be generated for this run.",
            skipped,
          },
        },
        { status: 422 },
      )
    }

    const zipBytes = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    })
    const bundleName = `payroll-${run.periodYear}-${String(
      run.periodMonth,
    ).padStart(2, "0")}.zip`

    return new NextResponse(zipBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${bundleName}"`,
        "Cache-Control": "no-store",
        // Lets the caller see how many files made it into the bundle
        // without unzipping first.
        "X-Bundle-File-Count": String(included.length),
        // Names of any bundle files that couldn't be rendered (e.g. bank
        // payor account not configured), so a partial (< 6-file) bundle
        // isn't mistaken for a complete one.
        ...(skipped.length > 0
          ? { "X-Bundle-Skipped": skipped.map((s) => s.kind).join(",") }
          : {}),
      },
    })
  },
)
