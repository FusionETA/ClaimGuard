"use client"

import * as React from "react"
import { useMemo, useState } from "react"
import { Download, FileText, Loader2 } from "lucide-react"
import JSZip from "jszip"

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
import { cn } from "@/lib/utils"
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
 * its own `/disbursement` endpoint).
 *
 * Every file is rendered ON DEMAND and streamed — nothing is stored on
 * disk. Each row's Download button fetches
 * `/admin/payroll/runs/<runId>/reports/<kind>` (which renders the bytes
 * fresh and returns them with a `Content-Disposition` filename), then
 * triggers a browser download of the resulting blob. Repeat clicks
 * simply re-render — there's no cached copy to go stale against the
 * live run.
 *
 * Each row ALSO has a checkbox. Tick a few rows (or the header "Select
 * all"), then hit "Download N selected" in the footer to grab them as
 * a single ZIP — handy when the admin needs to pull the whole bundle
 * for KWSP / SOCSO / LHDN upload in one go.
 */
export function PayrollDownloadsModal(props: {
  runId: string
  organizationName: string
  periodLabel: string
  /// True iff the run is SUBMITTED. Downloads require this.
  canGenerate: boolean
  /// Static per-kind meta rows to render (their `generated` is always
  /// null now — files are produced on demand, nothing is pre-generated).
  rows: PayrollReportRow[]
  /// Whether to show the bank disbursement CSV row (always available
  /// when SUBMITTED, served from the existing `/disbursement` route).
  showBankCsv: boolean
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  // `pendingKind` is keyed by report kind so each row has its own spinner.
  const [pendingKind, setPendingKind] = useState<PayrollReportKind | null>(
    null,
  )
  // Static meta list — no local mutation needed any more.
  const rows = props.rows

  // Admin-picked payment date for the PB ECP file. Defaults to the
  // last day of the period month on first open. PB accepts up to 60
  // days future-dated.
  const [pbEcpPaymentDate, setPbEcpPaymentDate] = useState<string>(() =>
    defaultPaymentDateIso(props.periodLabel),
  )
  // Bulk-download selection. We use kind strings as keys + the magic
  // string "BANK_CSV" for the generic disbursement CSV (which doesn't
  // have a PayrollReportKind because it goes through a separate route).
  const BANK_CSV_KEY = "__BANK_CSV__" as const
  type SelectionKey = PayrollReportKind | typeof BANK_CSV_KEY
  const [selected, setSelected] = useState<Set<SelectionKey>>(() => new Set())
  const [bulkPending, setBulkPending] = useState(false)

  /// Streaming download URL for one report kind. PB ECP carries the
  /// admin-picked payment date in the query string (it flows into both
  /// the file content and the bank-spec filename).
  function reportUrl(kind: PayrollReportKind): string {
    const base = `/admin/payroll/runs/${props.runId}/reports/${kind}`
    return kind === "BANK_PB_ECP_XLSX"
      ? `${base}?paymentDate=${encodeURIComponent(pbEcpPaymentDate)}`
      : base
  }

  async function handleDownload(kind: PayrollReportKind) {
    setPendingKind(kind)
    try {
      const res = await fetch(reportUrl(kind))
      if (!res.ok) {
        toast({ title: await readErrorMessage(res), variant: "error" })
        return
      }
      const blob = await res.blob()
      const fileName = fileNameFromResponse(res, fallbackFileName(rows, kind))
      const url = URL.createObjectURL(blob)
      triggerDownload(url, fileName)
      // Release the object URL on the next tick — Chrome keeps the
      // download stream open while the click event is being handled.
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : "Could not download this file.",
        variant: "error",
      })
    } finally {
      setPendingKind(null)
    }
  }

  // Group rows by section in the order REPORTS → STATUTORY → PAYSLIPS → BANK.
  const grouped: Record<PayrollReportGroup, PayrollReportRow[]> = {
    REPORTS: rows.filter((r) => r.group === "REPORTS"),
    STATUTORY: rows.filter((r) => r.group === "STATUTORY"),
    PAYSLIPS: rows.filter((r) => r.group === "PAYSLIPS"),
    BANK: rows.filter((r) => r.group === "BANK"),
  }

  // All selectable keys across the modal (every report row + the bank
  // CSV row, when shown). Used by the "Select all" header checkbox.
  const allSelectable: SelectionKey[] = useMemo(() => {
    const keys: SelectionKey[] = rows.map((r) => r.kind)
    if (props.showBankCsv) keys.push(BANK_CSV_KEY)
    return keys
  }, [rows, props.showBankCsv])

  const allChecked =
    allSelectable.length > 0 &&
    allSelectable.every((k) => selected.has(k))
  const someChecked =
    !allChecked && allSelectable.some((k) => selected.has(k))

  function toggleSelect(key: SelectionKey) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((prev) =>
      allChecked ? new Set() : new Set(allSelectable),
    )
  }

  async function handleBulkDownload() {
    if (selected.size === 0) return
    setBulkPending(true)
    const zip = new JSZip()
    const errors: string[] = []
    let added = 0

    try {
      // 1) Fetch every selected report kind's streaming URL and add the
      //    rendered bytes to the ZIP. Run sequentially so the server-side
      //    render queue isn't hammered by a big multi-select.
      for (const key of selected) {
        if (key === BANK_CSV_KEY) continue
        try {
          const res = await fetch(reportUrl(key))
          if (!res.ok) {
            errors.push(`${key}: ${await readErrorMessage(res)}`)
            continue
          }
          const blob = await res.blob()
          const fileName = fileNameFromResponse(res, fallbackFileName(rows, key))
          zip.file(fileName, blob)
          added++
        } catch (e) {
          errors.push(`${key}: ${e instanceof Error ? e.message : "unknown error"}`)
        }
      }

      // 2) Bank CSV — served by the disbursement route.
      if (selected.has(BANK_CSV_KEY)) {
        try {
          const href = `/admin/payroll/runs/${props.runId}/disbursement`
          const res = await fetch(href)
          if (!res.ok) {
            errors.push(`bank-csv: HTTP ${res.status}`)
          } else {
            const blob = await res.blob()
            // Try to read the filename out of Content-Disposition; fall
            // back to a sensible default if the server didn't set it.
            const fileName = fileNameFromResponse(
              res,
              `bank-disbursement-${props.runId}.csv`,
            )
            zip.file(fileName, blob)
            added++
          }
        } catch (e) {
          errors.push(`bank-csv: ${e instanceof Error ? e.message : "unknown error"}`)
        }
      }

      if (added === 0) {
        toast({
          title: errors[0] ?? "No files to download.",
          variant: "error",
        })
        return
      }

      // 3) Bundle the ZIP and trigger a single download.
      const zipBlob = await zip.generateAsync({ type: "blob" })
      const zipName = bundleFileName(props.organizationName, props.periodLabel)
      const url = URL.createObjectURL(zipBlob)
      triggerDownload(url, zipName)
      // Release the object URL on the next tick — Chrome keeps the
      // download stream open while the click event is being handled.
      setTimeout(() => URL.revokeObjectURL(url), 1500)

      if (errors.length > 0) {
        toast({
          title: `Bundled ${added} file${added === 1 ? "" : "s"}, skipped ${errors.length}: ${errors[0]}`,
          variant: "error",
        })
      } else {
        toast({
          title: `Downloaded ${added} file${added === 1 ? "" : "s"} as ZIP.`,
          variant: "success",
        })
      }
    } finally {
      setBulkPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Download className="h-4 w-4" />
          Download files
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
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

        {/* Select-all header — sits above the grouped list. Indeterminate
            when some-but-not-all rows are selected (visually rendered
            via the `data-state=indeterminate` attr the SelectAllCheckbox
            sets on the underlying input). */}
        {props.canGenerate && allSelectable.length > 0 ? (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs">
            <label className="flex items-center gap-2 font-medium text-foreground">
              <SelectAllCheckbox
                checked={allChecked}
                indeterminate={someChecked}
                onChange={toggleSelectAll}
                disabled={bulkPending}
              />
              Select all ({allSelectable.length})
            </label>
            <span className="text-muted-foreground">
              {selected.size > 0 ? `${selected.size} selected` : "none"}
            </span>
          </div>
        ) : null}

        <div className="nice-scrollbar -mr-2 max-h-[55vh] space-y-5 overflow-y-auto py-2 pl-1 pr-2">
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
                      bulkPending={bulkPending}
                      checked={selected.has(row.kind)}
                      onToggleSelect={() => toggleSelect(row.kind)}
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
                    bulkPending={bulkPending}
                    checked={selected.has(BANK_CSV_KEY)}
                    onToggleSelect={() => toggleSelect(BANK_CSV_KEY)}
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
                    bulkPending={bulkPending}
                    checked={selected.has(BANK_CSV_KEY)}
                    onToggleSelect={() => toggleSelect(BANK_CSV_KEY)}
                  />
                </li>
              </ul>
            </section>
          )}
        </div>

        <DialogFooter className="gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="default"
            disabled={
              !props.canGenerate || selected.size === 0 || bulkPending
            }
            onClick={handleBulkDownload}
            className="gap-2"
          >
            {bulkPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Bundling {selected.size}…
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                {selected.size === 0
                  ? "Download selected"
                  : `Download ${selected.size} selected as ZIP`}
              </>
            )}
          </Button>
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
  bulkPending: boolean
  checked: boolean
  onToggleSelect: () => void
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
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 cursor-pointer rounded border-border/70 accent-primary"
          checked={props.checked}
          onChange={props.onToggleSelect}
          disabled={props.disabled || props.bulkPending}
          aria-label={`Select ${row.title}`}
        />
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
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 gap-1.5"
        onClick={props.onDownload}
        disabled={props.disabled || props.pending || props.bulkPending}
      >
        {props.pending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Downloading…
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

function BankCsvRow(props: {
  runId: string
  disabled: boolean
  bulkPending: boolean
  checked: boolean
  onToggleSelect: () => void
}) {
  const href = `/admin/payroll/runs/${props.runId}/disbursement`
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-card/40 px-3 py-2.5",
        props.disabled && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 cursor-pointer rounded border-border/70 accent-primary"
          checked={props.checked}
          onChange={props.onToggleSelect}
          disabled={props.disabled || props.bulkPending}
          aria-label="Select Bank disbursement CSV"
        />
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
        disabled={props.disabled || props.bulkPending}
      >
        <a href={href} download>
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
      </Button>
    </div>
  )
}

/**
 * Tri-state header checkbox. Sets the underlying input's `indeterminate`
 * property via a ref because that property isn't reachable as a React
 * prop — React only knows `checked` / `defaultChecked`.
 */
function SelectAllCheckbox(props: {
  checked: boolean
  indeterminate: boolean
  disabled: boolean
  onChange: () => void
}) {
  const ref = React.useRef<HTMLInputElement | null>(null)
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.indeterminate
  }, [props.indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-4 w-4 cursor-pointer rounded border-border/70 accent-primary"
      checked={props.checked}
      onChange={props.onChange}
      disabled={props.disabled}
    />
  )
}

/**
 * Read a filename out of a `Content-Disposition` response header, falling
 * back to `fallback` when the header is missing/unparseable.
 */
function fileNameFromResponse(res: Response, fallback: string): string {
  const cd = res.headers.get("Content-Disposition") ?? ""
  const m = cd.match(/filename\*?="?([^";]+)"?/i)
  return m?.[1] ?? fallback
}

/**
 * Sensible fallback filename for a kind when the response didn't carry a
 * Content-Disposition — the report's title slugged + its extension.
 */
function fallbackFileName(rows: PayrollReportRow[], kind: PayrollReportKind): string {
  const row = rows.find((r) => r.kind === kind)
  if (!row) return kind.toLowerCase()
  const slug = row.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `${slug || kind.toLowerCase()}.${row.extension}`
}

/**
 * Read a JSON `{ error }` message off a failed response, falling back to
 * the HTTP status when the body isn't JSON.
 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string }
    if (data?.error) return data.error
  } catch {
    /* not JSON */
  }
  return `Could not download this file (HTTP ${res.status}).`
}

/**
 * Force a download against a URL by synthesising an anchor element
 * with `download` set.
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

/**
 * Filename for the bundled ZIP — e.g. `gosaas-january-2026-payroll.zip`.
 * Org name + period label, lowercase, spaces → hyphens, non-ascii
 * stripped. Falls back to `payroll-<runId>.zip` if both are empty.
 */
function bundleFileName(orgName: string, periodLabel: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  const parts = [slug(orgName), slug(periodLabel), "payroll"].filter(Boolean)
  const stem = parts.join("-") || "payroll-bundle"
  return `${stem}.zip`
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
