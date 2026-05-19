"use client"

import * as React from "react"
import { useState, useTransition } from "react"
import { Download, FileText, Loader2 } from "lucide-react"

import { generatePayrollReportAction } from "@/app/(admin)/admin/payroll/runs/[id]/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toaster"
import { cn, formatShortDate } from "@/lib/utils"
import {
  PAYROLL_REPORT_GROUP_LABELS,
  type PayrollReportGroup,
  type PayrollReportKind,
  type PayrollReportRow,
} from "@/modules/payroll/domain/reports"

/**
 * "Download files" modal on the payroll run detail page.
 *
 * Replaces the old "Download payroll summary PDF" + "Download bank
 * CSV" buttons with a single entry point. The modal lists every
 * downloadable file grouped into Reports / Statutory uploads /
 * Payslips, plus the bank disbursement CSV at the bottom (which has
 * its own non-cached `/disbursement` endpoint and skips the generator
 * flow entirely).
 *
 * Each row's Download button:
 *   - first click  → triggers `generatePayrollReportAction`, which
 *                    renders the file server-side, persists under
 *                    `public/uploads/payroll-reports/<runId>/`, and
 *                    returns the URL. The browser then triggers a
 *                    download against that URL.
 *   - later clicks → reads the cached file from the same URL (no
 *                    server-side render).
 */
export function PayrollDownloadsModal(props: {
  runId: string
  organizationName: string
  periodLabel: string
  /// True iff the run is SUBMITTED. The 7 cached files require this.
  canGenerate: boolean
  /// Already-cached rows so the modal can pre-populate "generated on…"
  /// stamps without an extra round-trip.
  rows: PayrollReportRow[]
  /// Whether to show the bank disbursement CSV row (always available
  /// when SUBMITTED, served from the existing `/disbursement` route).
  showBankCsv: boolean
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  // `pending` is keyed by report kind so each row has its own spinner.
  const [pendingKind, setPendingKind] = useState<PayrollReportKind | null>(
    null,
  )
  const [, startTransition] = useTransition()
  // Local row state so a successful generation immediately shows the
  // "Generated <date>" label without waiting for a server refresh.
  const [rows, setRows] = useState(props.rows)
  // Admin-picked payment date for the PB ECP file. Defaults to the
  // last day of the period month on first open. PB accepts up to 60
  // days future-dated.
  const [pbEcpPaymentDate, setPbEcpPaymentDate] = useState<string>(() =>
    defaultPaymentDateIso(props.periodLabel),
  )

  function handleDownload(kind: PayrollReportKind) {
    setPendingKind(kind)
    startTransition(async () => {
      try {
        const result = await generatePayrollReportAction({
          runId: props.runId,
          kind,
          paymentDate:
            kind === "BANK_PB_ECP_XLSX" ? pbEcpPaymentDate : undefined,
        })
        if (result.status === "error") {
          toast({
            title: result.message,
            variant: "error",
          })
          return
        }
        // Trigger the actual file download.
        triggerDownload(result.fileUrl, result.fileName)
        // Optimistically update the row so the "generated" stamp shows
        // up immediately.
        setRows((prev) =>
          prev.map((r) =>
            r.kind === kind
              ? {
                  ...r,
                  generated: {
                    fileName: result.fileName,
                    fileUrl: result.fileUrl,
                    sizeBytes: result.sizeBytes,
                    generatedAt: new Date().toISOString(),
                  },
                }
              : r,
          ),
        )
      } finally {
        setPendingKind(null)
      }
    })
  }

  // Group rows by section in the order REPORTS → STATUTORY → PAYSLIPS → BANK.
  const grouped: Record<PayrollReportGroup, PayrollReportRow[]> = {
    REPORTS: rows.filter((r) => r.group === "REPORTS"),
    STATUTORY: rows.filter((r) => r.group === "STATUTORY"),
    PAYSLIPS: rows.filter((r) => r.group === "PAYSLIPS"),
    BANK: rows.filter((r) => r.group === "BANK"),
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Download className="h-4 w-4" />
          Download files
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Download files — {props.periodLabel}</DialogTitle>
          <DialogDescription>
            {props.organizationName ? `${props.organizationName} · ` : ""}
            Reports, statutory uploads, and payslips for this run.
            {!props.canGenerate
              ? " Submit + approve the run before generating files."
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {(["REPORTS", "STATUTORY", "PAYSLIPS", "BANK"] as const).map((group) => {
            const groupRows = grouped[group]
            if (groupRows.length === 0) return null
            return (
              <section key={group} className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {PAYROLL_REPORT_GROUP_LABELS[group]}
                </h3>
                {/* PB ECP needs a payment-date picker since the date is
                    embedded in both the file content (Row 1) and the
                    filename (DDMMYY). Render it once at the top of the
                    BANK group when there's a PB ECP row in the list. */}
                {group === "BANK" &&
                groupRows.some((r) => r.kind === "BANK_PB_ECP_XLSX") ? (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                    <label
                      htmlFor="pb-ecp-payment-date"
                      className="font-medium text-foreground"
                    >
                      PB ECP payment date
                    </label>
                    <input
                      id="pb-ecp-payment-date"
                      type="date"
                      value={pbEcpPaymentDate}
                      onChange={(e) => setPbEcpPaymentDate(e.target.value)}
                      min={todayIso()}
                      max={maxFutureDateIso(60)}
                      className="rounded-md border border-border/60 bg-background px-2 py-1 text-xs"
                    />
                    <span className="text-muted-foreground">
                      (Up to 60 days future-dated)
                    </span>
                  </div>
                ) : null}
                <ul className="space-y-1.5">
                  {groupRows.map((row) => (
                    <ReportRow
                      key={row.kind}
                      row={row}
                      disabled={!props.canGenerate}
                      pending={pendingKind === row.kind}
                      onDownload={() => handleDownload(row.kind)}
                    />
                  ))}
                </ul>
              </section>
            )
          })}

          {/* Generic bank disbursement CSV — fallback for non-PB banks
              or admins who prefer to paste rows into their bank's own
              bulk-transfer template. Served fresh from the existing
              `/disbursement` route (no caching). Renders under the
              Bank disbursement group only when no PB ECP row is
              available for this org. */}
          {props.showBankCsv && grouped.BANK.length === 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Bank disbursement
              </h3>
              <ul className="space-y-1.5">
                <li>
                  <BankCsvRow
                    runId={props.runId}
                    disabled={!props.canGenerate}
                  />
                </li>
              </ul>
            </section>
          )}
          {/* When the BANK group has rows (e.g. PB ECP), we still
              render the generic CSV alongside as a fallback option
              inside the same section. */}
          {props.showBankCsv && grouped.BANK.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Generic CSV (fallback)
              </h3>
              <ul className="space-y-1.5">
                <li>
                  <BankCsvRow
                    runId={props.runId}
                    disabled={!props.canGenerate}
                  />
                </li>
              </ul>
            </section>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReportRow(props: {
  row: PayrollReportRow
  disabled: boolean
  pending: boolean
  onDownload: () => void
}) {
  const { row } = props
  return (
    <li
      className={cn(
        "flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5",
        props.disabled && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {row.title}
            {row.portal ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                → {row.portal}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {row.description}
          </p>
          {row.generated ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground/80">
              Generated {formatShortDate(new Date(row.generated.generatedAt))} ·{" "}
              {formatFileSize(row.generated.sizeBytes)}
            </p>
          ) : null}
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 gap-1.5"
        onClick={props.onDownload}
        disabled={props.disabled || props.pending}
      >
        {props.pending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {row.generated ? "Downloading…" : "Generating…"}
          </>
        ) : (
          <>
            <Download className="h-3.5 w-3.5" />
            Download
          </>
        )}
      </Button>
    </li>
  )
}

function BankCsvRow(props: { runId: string; disabled: boolean }) {
  const href = `/admin/payroll/runs/${props.runId}/disbursement`
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5",
        props.disabled && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Bank disbursement CSV
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              → Your bank&apos;s bulk transfer upload
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            One row per payslip with employee bank details + net pay
            amount.
          </p>
        </div>
      </div>
      <Button
        asChild
        variant="outline"
        size="sm"
        className="shrink-0 gap-1.5"
        disabled={props.disabled}
      >
        <a href={href} download>
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
      </Button>
    </div>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Force a download against a URL by synthesising an anchor element
 * with `download` set. Works for any same-origin URL — the cached
 * files under `/uploads/...` are served by Next.js' built-in static
 * handler.
 */
function triggerDownload(url: string, fileName: string) {
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function toIsoDate(d: Date): string {
  const yyyy = String(d.getFullYear())
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

function todayIso(): string {
  return toIsoDate(new Date())
}

function maxFutureDateIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return toIsoDate(d)
}

/// Default payment date for the modal — last day of the run's period
/// month, OR today if that day has already passed. `periodLabel` comes
/// in as "January 2026" / "Jan 2026" — fall back to today if it can't
/// be parsed.
function defaultPaymentDateIso(periodLabel: string): string {
  const today = new Date()
  const match = periodLabel.match(/(\w+)\s+(\d{4})/)
  if (!match) return toIsoDate(today)
  const month = parseMonth(match[1])
  const year = Number(match[2])
  if (month == null || !Number.isInteger(year)) return toIsoDate(today)
  const lastDay = new Date(year, month, 0)
  // If the period has already ended, default to today so the picker
  // doesn't start on a backdated value (PB rejects backdated files).
  return lastDay < today ? toIsoDate(today) : toIsoDate(lastDay)
}

function parseMonth(s: string): number | null {
  const t = s.trim().slice(0, 3).toLowerCase()
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  }
  return months[t] ?? null
}
