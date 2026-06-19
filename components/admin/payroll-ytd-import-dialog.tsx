"use client"

import { useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react"

import { importYtdPayrollHistoryAction } from "@/app/(admin)/admin/payroll/runs/actions"
import type {
  YtdImportActionResult,
  YtdImportSummaryShape,
} from "@/app/(admin)/admin/payroll/runs/form-state"
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
 * Import payroll history — two-step modal:
 *
 *   1. Download the YTD template pre-filled with the org's employees.
 *   2. Upload the filled XLSX; the importer matches by NRIC / passport
 *      and writes historical runs marked source=IMPORTED (status
 *      SUBMITTED, immutable).
 *
 * The dialog handles its own progress state (no useActionState) so
 * the structured summary survives back to the UI instead of being
 * flattened into a single toast message.
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
  const { toast } = useToast()

  const yearNum = Number(year)
  const yearValid =
    Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100

  function reset() {
    setFile(null)
    setResult(null)
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) reset()
  }

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
  }

  async function handleImport() {
    if (!file || !yearValid || importing) return
    setImporting(true)
    setResult(null)
    try {
      const formData = new FormData()
      formData.append("year", String(yearNum))
      formData.append("file", file)
      const r = await importYtdPayrollHistoryAction(formData)
      setResult(r)
      if (r.ok) {
        toast({
          title: `Imported ${r.summary.importedPayslips} payslip${
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
            calculated. Two steps — download the template, fill it in,
            then upload it back.
          </DialogDescription>
        </DialogHeader>

        <div className="nice-scrollbar -mr-2 max-h-[65vh] space-y-5 overflow-y-auto py-2 pr-2">
          {/* Year picker — drives both steps. */}
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
              Matches each row to an existing employee by NRIC / Passport.
              Unknown IDs are skipped (we&apos;ll list them). Months that
              already have a computed run are skipped too — historical
              data is never overwritten.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleFileChange}
                className="max-w-xs"
                disabled={importing}
              />
              <Button
                type="button"
                variant="default"
                className="gap-2"
                onClick={handleImport}
                disabled={!file || !yearValid || importing}
              >
                {importing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileSpreadsheet className="h-4 w-4" />
                )}
                {importing ? "Importing…" : "Import"}
              </Button>
            </div>
            {file && (
              <p className="text-[11px] text-muted-foreground">
                Selected: <span className="font-mono">{file.name}</span> (
                {Math.round(file.size / 1024)} KB)
              </p>
            )}
          </section>

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
      </section>
    )
  }
  return <SummaryPanel summary={result.summary} />
}

function SummaryPanel({ summary }: { summary: YtdImportSummaryShape }) {
  const hasIssues =
    summary.parserErrors.length > 0 ||
    summary.parserWarnings.length > 0 ||
    summary.skippedUnknownEmployees.length > 0 ||
    summary.skippedExistingPayslips.length > 0 ||
    summary.skippedConflictingPeriods.length > 0

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
        {summary.skippedExistingPayslips.length > 0 && (
          <li className="text-amber-800 dark:text-amber-300">
            Skipped{" "}
            <span className="font-semibold">
              {summary.skippedExistingPayslips.length}
            </span>{" "}
            already-imported payslip
            {summary.skippedExistingPayslips.length === 1 ? "" : "s"}.
          </li>
        )}
        {summary.skippedConflictingPeriods.length > 0 && (
          <li className="text-amber-800 dark:text-amber-300">
            Skipped{" "}
            <span className="font-semibold">
              {summary.skippedConflictingPeriods.length}
            </span>{" "}
            month
            {summary.skippedConflictingPeriods.length === 1 ? "" : "s"} that
            already have a computed run.
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
      {summary.skippedConflictingPeriods.length > 0 && (
        <DetailList
          title="Months with conflicting runs"
          items={summary.skippedConflictingPeriods.map(
            (p) => `${MONTH_LABELS[p.monthIdx]} ${p.year} — ${p.reason}`,
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
