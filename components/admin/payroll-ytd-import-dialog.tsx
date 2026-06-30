"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Info,
  Loader2,
  Upload,
} from "lucide-react"

import {
  getYtdImportYearContextAction,
  importYtdPayrollHistoryAction,
  previewYtdImportColumnsAction,
} from "@/app/(admin)/admin/payroll/runs/actions"
import type {
  YtdImportActionResult,
  YtdImportColumnInfoShape,
  YtdImportSummaryShape,
  YtdImportYearContext,
} from "@/app/(admin)/admin/payroll/runs/form-state"
import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  payrollAdjustmentCategories,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"
import { NativeSelect } from "@/components/admin/payroll-form-controls"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/**
 * Import payroll history — two-step modal.
 *
 *   1. Download the YTD template pre-filled with the org's employees.
 *   2. Upload the filled XLSX. The importer follows the "one year,
 *      one upload" rule:
 *        - The latest upload is the single source of truth for the
 *          year — re-uploading replaces every IMPORTED row for that
 *          year, atomically.
 *        - Any month in the upload that overlaps a COMPUTED run
 *          (DRAFT / PENDING / SUBMITTED) rejects the entire upload —
 *          imports never overwrite or coexist with engine output.
 *
 * The dialog fetches a year-context snapshot when the year changes so
 * we can surface BOTH conditions inline before the admin commits.
 */
export function PayrollYtdImportDialog({
  defaultYear,
}: {
  defaultYear: number
}) {
  const [open, setOpen] = useState(false)
  const [year, setYear] = useState<string>(String(defaultYear))
  const [downloading, setDownloading] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<YtdImportActionResult | null>(null)
  const [yearContext, setYearContext] = useState<YtdImportYearContext | null>(
    null,
  )
  const [yearContextLoading, setYearContextLoading] = useState(false)
  // Column preview + mapping state — populated when the admin picks a
  // file. `unknownColumns` drives whether the mapping UI renders at
  // all (it's hidden when every column auto-matched). `mapping` is
  // keyed by the column's NORMALIZED header text (matches the parser
  // side); value is a category code or "SKIP".
  const [columnPreview, setColumnPreview] = useState<
    YtdImportColumnInfoShape[] | null
  >(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [mapping, setMapping] = useState<
    Record<string, PayrollAdjustmentCategory | "SKIP">
  >({})
  const { toast } = useToast()

  const yearNum = Number(year)
  const yearValid =
    Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100

  function reset() {
    setFile(null)
    setResult(null)
    setColumnPreview(null)
    setPreviewError(null)
    setMapping({})
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) reset()
  }

  // Fetch the year-context snapshot whenever the dialog opens or the
  // year changes. Debounced via a 300ms delay so typing "2026" doesn't
  // fire four times back-to-back.
  const fetchYearContext = useCallback(
    async (signal: AbortSignal) => {
      if (!yearValid) {
        setYearContext(null)
        return
      }
      setYearContextLoading(true)
      try {
        const r = await getYtdImportYearContextAction({ year: yearNum })
        if (signal.aborted) return
        if (r.ok) setYearContext(r.context)
        else setYearContext(null)
      } catch {
        if (!signal.aborted) setYearContext(null)
      } finally {
        if (!signal.aborted) setYearContextLoading(false)
      }
    },
    [yearNum, yearValid],
  )

  useEffect(() => {
    if (!open) return
    const ctrl = new AbortController()
    const t = setTimeout(() => fetchYearContext(ctrl.signal), 300)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [open, fetchYearContext])

  async function handleDownload() {
    if (!yearValid || downloading) return
    setDownloading(true)
    try {
      const response = await fetch(
        `/api/admin/payroll/ytd-import-template?year=${yearNum}`,
        { method: "GET", credentials: "same-origin" },
      )
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        toast({
          title:
            body?.error ?? `Couldn't generate template (HTTP ${response.status}).`,
          variant: "error",
        })
        return
      }
      const cd = response.headers.get("Content-Disposition") ?? ""
      const match = cd.match(/filename="?([^";]+)"?/i)
      const filename = match?.[1] ?? `ytd-import-${yearNum}.xlsx`
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.rel = "noopener"
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1500)
      toast({
        title: `Downloaded ${filename}.`,
        variant: "success",
      })
    } catch (err) {
      toast({
        title:
          err instanceof Error
            ? err.message
            : "Couldn't generate template.",
        variant: "error",
      })
    } finally {
      setDownloading(false)
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.files?.[0] ?? null
    if (next && !next.name.toLowerCase().endsWith(".xlsx")) {
      toast({
        title: "Please pick an .xlsx file (Excel workbook).",
        variant: "error",
      })
      e.target.value = ""
      return
    }
    setFile(next)
    setResult(null)
    setColumnPreview(null)
    setPreviewError(null)
    setMapping({})
    if (next) void runColumnPreview(next)
  }

  async function runColumnPreview(picked: File) {
    setPreviewLoading(true)
    try {
      const formData = new FormData()
      formData.append("file", picked)
      const r = await previewYtdImportColumnsAction(formData)
      if (r.ok) {
        setColumnPreview(r.columns)
        // Pre-fill mapping: every UNKNOWN column starts unmapped (empty
        // string = "pick a category"). Admin sees an inline dropdown
        // for each. Auto-matched columns aren't in the mapping dict at
        // all — they continue to flow through the existing auto-detect
        // path in the parser, no override needed.
        setMapping({})
      } else {
        setPreviewError(r.message)
      }
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : "Couldn't read column headers.",
      )
    } finally {
      setPreviewLoading(false)
    }
  }

  // Renderable columns for the mapping panel: every column except
  // Full Name / Personal ID. Mandatory ones display as locked,
  // auto-matched ones display pre-filled but editable, unknown ones
  // require an explicit choice.
  const mappableColumns = columnPreview
    ? columnPreview.filter((c) => c.autoMatch.kind !== "nameOrId")
    : []
  // Unknown headers awaiting an admin decision (no override picked yet,
  // not even "Skip"). Gate the Import button so they can't ship an
  // import with unmapped columns silently dropped.
  const unmappedUnknownCount = mappableColumns.filter(
    (c) => c.autoMatch.kind === "unknown" && !mapping[c.normalized],
  ).length

  async function handleImport() {
    if (!file || !yearValid || importing) return
    if (unmappedUnknownCount > 0) {
      toast({
        title: `Map or skip ${unmappedUnknownCount} unknown column${
          unmappedUnknownCount === 1 ? "" : "s"
        } before importing.`,
        variant: "error",
      })
      return
    }
    setImporting(true)
    setResult(null)
    try {
      const formData = new FormData()
      formData.append("year", String(yearNum))
      formData.append("file", file)
      if (Object.keys(mapping).length > 0) {
        formData.append("columnOverrides", JSON.stringify(mapping))
      }
      const r = await importYtdPayrollHistoryAction(formData)
      setResult(r)
      if (r.ok) {
        // Refresh the year context — after a successful import this
        // year now has imported months (relevant if admin re-imports).
        const ctrl = new AbortController()
        void fetchYearContext(ctrl.signal)
        toast({
          title:
            r.summary.replacedRuns > 0
              ? `Replaced ${r.summary.replacedRuns} imported run${
                  r.summary.replacedRuns === 1 ? "" : "s"
                } with ${r.summary.importedPayslips} new payslip${
                  r.summary.importedPayslips === 1 ? "" : "s"
                }.`
              : `Imported ${r.summary.importedPayslips} payslip${
                  r.summary.importedPayslips === 1 ? "" : "s"
                } across ${r.summary.importedRunsCreated} run${
                  r.summary.importedRunsCreated === 1 ? "" : "s"
                }.`,
          variant: "success",
        })
      } else {
        toast({ title: r.message, variant: "error" })
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Upload failed."
      setResult({ ok: false, message })
      toast({ title: message, variant: "error" })
    } finally {
      setImporting(false)
    }
  }

  const importedMonths = yearContext?.importedMonths ?? []
  const computedMonths = yearContext?.computedMonths ?? []
  const willReplaceCount = importedMonths.length
  const importButtonLabel = importing
    ? "Importing…"
    : willReplaceCount > 0
      ? `Replace ${willReplaceCount} import${willReplaceCount === 1 ? "" : "s"}`
      : "Import"

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="gap-2">
          <Upload className="h-4 w-4" />
          Import payroll history
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Import payroll history</DialogTitle>
          <DialogDescription>
            Bring in past months from your previous payroll system so
            PCB has the right cumulative YTD when the next run is
            calculated. One upload per year — the latest file is the
            single source of truth.
          </DialogDescription>
        </DialogHeader>

        {/* `px-1` gives focus rings on inputs/buttons inside the
            scroll area room to render without clipping against the
            container's left edge — see components/CLAUDE.md. */}
        <div className="nice-scrollbar -mr-2 max-h-[65vh] space-y-5 overflow-y-auto py-2 pl-1 pr-2">
          {/* Year picker — drives both steps + the context warnings. */}
          <div className="space-y-1.5">
            <Label htmlFor="ytd-year">Year of payroll history</Label>
            <Input
              id="ytd-year"
              value={year}
              onChange={(e) => setYear(e.target.value)}
              inputMode="numeric"
              className="max-w-[140px]"
              placeholder="2026"
            />
            {!yearValid && year.length > 0 && (
              <p className="text-xs text-destructive">
                Year must be 4 digits between 2000 and 2100.
              </p>
            )}
          </div>

          {/* Year context warnings — only when the year is valid and
              we've got data back. */}
          {yearValid && yearContext && !yearContextLoading && (
            <YearContextWarnings
              year={yearNum}
              importedMonths={importedMonths}
              computedMonths={computedMonths}
            />
          )}

          {/* Step 1 — Download template */}
          <section className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-4">
            <header className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                1
              </span>
              <h3 className="text-sm font-semibold">Download template</h3>
            </header>
            <p className="text-xs text-muted-foreground">
              Pre-filled with your employees and 12 month rows each.
              Fill in past months&apos; basic salary, PCB, EPF, SOCSO,
              EIS, HRDF (and optional allowances) for each employee.
            </p>
            <Button
              type="button"
              variant="default"
              className="gap-2"
              onClick={handleDownload}
              disabled={!yearValid || downloading}
            >
              {downloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {downloading
                ? "Preparing…"
                : `Download ${yearValid ? yearNum : ""} template`}
            </Button>
          </section>

          {/* Step 2 — Upload filled template */}
          <section className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-4">
            <header className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                2
              </span>
              <h3 className="text-sm font-semibold">Upload filled template</h3>
            </header>
            <p className="text-xs text-muted-foreground">
              Matches each row to an existing employee by NRIC /
              Passport. Unknown IDs are skipped (we&apos;ll list them).
              If any month in the file collides with an existing
              computed run, the whole upload fails — fix the file and
              re-upload.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleFileChange}
                // `cursor-pointer` covers the input's text area;
                // `file:cursor-pointer` targets the browser-rendered
                // "Choose file" button inside the input (it's a
                // pseudo-element and needs its own modifier).
                className="max-w-xs cursor-pointer file:cursor-pointer"
                disabled={importing}
              />
              <Button
                type="button"
                variant={willReplaceCount > 0 ? "destructive" : "default"}
                className="gap-2"
                onClick={handleImport}
                disabled={!file || !yearValid || importing}
              >
                {importing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileSpreadsheet className="h-4 w-4" />
                )}
                {importButtonLabel}
              </Button>
            </div>
            {file && (
              <p className="text-[11px] text-muted-foreground">
                Selected: <span className="font-mono">{file.name}</span> (
                {Math.round(file.size / 1024)} KB)
              </p>
            )}
            {previewLoading && (
              <p className="text-[11px] text-muted-foreground">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                Reading column headers…
              </p>
            )}
            {previewError && (
              <p className="text-[11px] text-destructive">{previewError}</p>
            )}
          </section>

          {/* Column mapping — always rendered after a file is picked.
              Shows every column in the file so admin can see what was
              auto-detected and override if they want. Mandatory (e.g.
              Basic Salary, EPF) are locked — overriding them would
              break the calc. Auto-matched optional columns are pre-
              filled but editable. Unknown columns require an explicit
              choice (Import button blocked until each is decided).
              Multiple columns mapped to the same category sum per
              employee per month. */}
          {mappableColumns.length > 0 && (
            <ColumnMappingPanel
              columns={mappableColumns}
              mapping={mapping}
              onChange={(normalized, value) =>
                setMapping((prev) => {
                  const next = { ...prev }
                  if (!value) delete next[normalized]
                  else next[normalized] = value
                  return next
                })
              }
            />
          )}

          {/* Result summary — only after a real attempt. */}
          {result && <ResultPanel result={result} />}
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

// ─── Column mapping panel ──────────────────────────────────────────

/**
 * Inline mapping UI rendered after a file is picked. Shows every
 * non-name/id column with one of three behaviours:
 *
 *   1. **Mandatory** (Basic Salary / EPF / SOCSO / PCB / HRDF) —
 *      locked row, dropdown disabled. Re-routing these would break
 *      the calc engine, so admin can only see the auto-detect result.
 *
 *   2. **Auto-matched optional** (Bonus, Phone Allowance, Annual
 *      Bonus, etc.) — dropdown defaults to the matched category but
 *      is editable. Admin can override (e.g. re-route "Bonus" to
 *      `wages_bonus_annual` instead of the legacy bonus scalar) or
 *      skip the column entirely.
 *
 *   3. **Unknown** — dropdown blank, must select a category or
 *      "Skip this column". Import button is blocked until every
 *      unknown row has a decision.
 *
 * Multiple columns mapped (or auto-matched) to the same category get
 * summed per employee per month at calc time.
 */
function ColumnMappingPanel({
  columns,
  mapping,
  onChange,
}: {
  columns: YtdImportColumnInfoShape[]
  mapping: Record<string, PayrollAdjustmentCategory | "SKIP">
  onChange: (
    normalizedHeader: string,
    next: PayrollAdjustmentCategory | "SKIP" | null,
  ) => void
}) {
  // Group categories by their `group` field for the dropdown's
  // <optgroup>s.
  const groupedCategories = useMemo(() => {
    const out = new Map<string, PayrollAdjustmentCategory[]>()
    for (const code of payrollAdjustmentCategories) {
      const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[code]
      if (!meta) continue
      const list = out.get(meta.group) ?? []
      list.push(code)
      out.set(meta.group, list)
    }
    return out
  }, [])

  const unknownCount = columns.filter(
    (c) => c.autoMatch.kind === "unknown",
  ).length
  const headerColor =
    unknownCount > 0
      ? "border-amber-300/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/15"
      : "border-border/60 bg-card/40"

  return (
    <section className={cn("space-y-2 rounded-lg border p-4", headerColor)}>
      <header className="flex items-center gap-2">
        {unknownCount > 0 ? (
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-300" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
        )}
        <h3 className="text-sm font-semibold">
          {unknownCount > 0
            ? `Map ${unknownCount} unknown column${unknownCount === 1 ? "" : "s"}`
            : "Column mapping"}
        </h3>
      </header>
      <p className="text-xs text-muted-foreground">
        Review the auto-detected category for each column. Mandatory
        columns are locked. Optional columns are editable — leave the
        dropdown alone to keep the auto-match, or pick a different
        category to override. Unknown columns must be mapped or skipped
        before importing.
        <br />
        Multiple columns mapped to the same category get summed per
        employee per month.
      </p>
      <div className="space-y-2 pt-1">
        {columns.map((col) => {
          const kind = col.autoMatch.kind
          const isMandatory = kind === "mandatory"
          const isUnknown = kind === "unknown"
          const current = mapping[col.normalized] ?? ""

          // Resolve what category (if any) the auto-detect found, so we
          // can display it as the "Keep auto-match: X" option and pre-
          // select it visually when admin hasn't overridden.
          let autoMatchedLabel: string | null = null
          let autoMatchedKind: string | null = null
          if (kind === "mandatory") {
            autoMatchedLabel = `Statutory · ${col.rawText}`
            autoMatchedKind = "mandatory"
          } else if (kind === "optionalLegacy") {
            autoMatchedLabel = `Legacy column: ${col.autoMatch.amountKey}`
            autoMatchedKind = "auto"
          } else if (kind === "standardCategory") {
            const meta =
              PAYROLL_ADJUSTMENT_CATEGORY_META[
                col.autoMatch.categoryCode as PayrollAdjustmentCategory
              ]
            autoMatchedLabel = meta?.label ?? col.autoMatch.categoryCode
            autoMatchedKind = "auto"
          }

          return (
            <div
              key={col.normalized}
              className="grid items-center gap-2 sm:grid-cols-[1fr_1.4fr]"
            >
              <div className="flex items-center gap-2 text-xs">
                <span className="font-mono font-semibold">{col.rawText}</span>
                {isMandatory ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Statutory
                  </span>
                ) : isUnknown ? (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
                    Unknown
                  </span>
                ) : current ? (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-800 dark:bg-blue-950/50 dark:text-blue-200">
                    Overridden
                  </span>
                ) : (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200">
                    Auto-matched
                  </span>
                )}
              </div>
              {isMandatory ? (
                <div className="text-xs text-muted-foreground">
                  {autoMatchedLabel} — locked
                </div>
              ) : (
                <NativeSelect
                  aria-label={`Map column ${col.rawText}`}
                  value={current}
                  onChange={(e) => {
                    const v = e.target.value
                    if (!v) onChange(col.normalized, null)
                    else if (v === "SKIP") onChange(col.normalized, "SKIP")
                    else
                      onChange(
                        col.normalized,
                        v as PayrollAdjustmentCategory,
                      )
                  }}
                >
                  {isUnknown ? (
                    <option value="">— Select category —</option>
                  ) : (
                    <option value="">
                      Keep auto-match: {autoMatchedLabel}
                    </option>
                  )}
                  <option value="SKIP">Skip this column</option>
                  {Array.from(groupedCategories.entries()).map(
                    ([group, codes]) => (
                      <optgroup key={group} label={group}>
                        {codes.map((code) => {
                          const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[code]
                          return (
                            <option key={code} value={code}>
                              {meta.label} ({meta.kind.toLowerCase()})
                            </option>
                          )
                        })}
                      </optgroup>
                    ),
                  )}
                </NativeSelect>
              )}
            </div>
          )
        })}
      </div>
      <p className="pt-1 text-[11px] text-muted-foreground">
        Tip: <strong>Keep auto-match</strong> on an optional column
        means the importer uses the detected category. Pick another
        category to override, or <strong>Skip this column</strong> to
        ignore it entirely (no warning).
      </p>
    </section>
  )
}

// ─── Year context warnings ─────────────────────────────────────────

function YearContextWarnings({
  year,
  importedMonths,
  computedMonths,
}: {
  year: number
  importedMonths: number[]
  computedMonths: number[]
}) {
  if (importedMonths.length === 0 && computedMonths.length === 0) {
    return null
  }
  return (
    <div className="space-y-2">
      {importedMonths.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 p-3 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <strong>{importedMonths.length}</strong> imported month
            {importedMonths.length === 1 ? "" : "s"} already on file for{" "}
            {year} ({importedMonths.map((m) => MONTH_LABELS[m - 1]).join(", ")}).
            Re-uploading will{" "}
            <strong>delete and replace</strong> them — the new file
            becomes the single source of truth.
          </div>
        </div>
      )}
      {computedMonths.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-rose-300/60 bg-rose-50/60 p-3 text-xs text-rose-900 dark:border-rose-700/40 dark:bg-rose-950/20 dark:text-rose-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <strong>
              {computedMonths.map((m) => MONTH_LABELS[m - 1]).join(", ")}
            </strong>{" "}
            already {computedMonths.length === 1 ? "has" : "have"} a
            computed payroll run in {year}. The upload <strong>will fail</strong>{" "}
            if your file includes any of these months — engine-produced
            runs can&apos;t be overwritten by an import.
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Result panel ──────────────────────────────────────────────────

function ResultPanel({ result }: { result: YtdImportActionResult }) {
  if (!result.ok) {
    return (
      <section className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <header className="flex items-center gap-2 text-sm font-semibold text-destructive">
          <AlertTriangle className="h-4 w-4" />
          Import failed
        </header>
        <p className="text-xs text-destructive/90">{result.message}</p>
        {result.conflictingMonths && result.conflictingMonths.length > 0 && (
          <p className="text-xs text-destructive/90">
            Conflicting months:{" "}
            <strong>
              {result.conflictingMonths
                .map((m) => MONTH_LABELS[m - 1])
                .join(", ")}
            </strong>
            . Remove these rows from the file (or delete the existing
            computed runs first), then upload again.
          </p>
        )}
      </section>
    )
  }
  return <SummaryPanel summary={result.summary} />
}

function SummaryPanel({ summary }: { summary: YtdImportSummaryShape }) {
  const hasIssues =
    summary.parserErrors.length > 0 ||
    summary.parserWarnings.length > 0 ||
    summary.skippedUnknownEmployees.length > 0

  const accent = hasIssues
    ? "border-amber-300/60 bg-amber-50/60 dark:border-amber-700/40 dark:bg-amber-950/20"
    : "border-emerald-300/60 bg-emerald-50/60 dark:border-emerald-700/40 dark:bg-emerald-950/20"

  return (
    <section className={cn("space-y-3 rounded-lg border p-4", accent)}>
      <header className="flex items-center gap-2 text-sm font-semibold">
        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        Import summary
      </header>
      <ul className="space-y-1 text-xs">
        <li>
          <span className="font-semibold">{summary.importedPayslips}</span> payslip
          {summary.importedPayslips === 1 ? "" : "s"} imported across{" "}
          <span className="font-semibold">{summary.importedRunsCreated}</span>{" "}
          new run{summary.importedRunsCreated === 1 ? "" : "s"}.
        </li>
        {summary.replacedRuns > 0 && (
          <li className="text-amber-800 dark:text-amber-300">
            Replaced{" "}
            <span className="font-semibold">{summary.replacedRuns}</span>{" "}
            previously-imported run
            {summary.replacedRuns === 1 ? "" : "s"} for this year.
          </li>
        )}
        {summary.skippedUnknownEmployees.length > 0 && (
          <li className="text-amber-800 dark:text-amber-300">
            Skipped{" "}
            <span className="font-semibold">
              {summary.skippedUnknownEmployees.length}
            </span>{" "}
            unknown employee
            {summary.skippedUnknownEmployees.length === 1 ? "" : "s"} (no
            matching NRIC / Passport).
          </li>
        )}
      </ul>

      {summary.skippedUnknownEmployees.length > 0 && (
        <DetailList
          title="Unknown employees"
          items={summary.skippedUnknownEmployees.map(
            (e) => `${e.name} — ${e.idNumber}`,
          )}
        />
      )}
      {summary.parserWarnings.length > 0 && (
        <DetailList title="Parser warnings" items={summary.parserWarnings} />
      )}
      {summary.parserErrors.length > 0 && (
        <DetailList title="Parser errors" items={summary.parserErrors} />
      )}
    </section>
  )
}

function DetailList({
  title,
  items,
}: {
  title: string
  items: string[]
}) {
  if (items.length === 0) return null
  return (
    <details className="rounded-md border border-border/60 bg-background/60 p-2 text-[11px]">
      <summary className="cursor-pointer font-semibold text-muted-foreground">
        {title} ({items.length})
      </summary>
      <ul className="mt-1.5 space-y-0.5 pl-3 text-muted-foreground">
        {items.slice(0, 50).map((line, i) => (
          <li key={i} className="font-mono">
            {line}
          </li>
        ))}
        {items.length > 50 && (
          <li className="italic">…and {items.length - 50} more.</li>
        )}
      </ul>
    </details>
  )
}
