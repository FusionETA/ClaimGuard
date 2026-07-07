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

import { importPayrollRunAdjustmentsAction } from "@/app/(admin)/admin/payroll/runs/[id]/actions"
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

type ImportResult =
  | {
      status: "success"
      employeesAffected: number
      linesWritten: number
      employeesWithoutFileEntry: number
    }
  | {
      status: "error"
      message: string
      rowErrors?: Array<{ rowNumber: number; message: string }>
    }

/**
 * Dialog for bulk-uploading manual adjustments to a DRAFT payroll run.
 * Two-step:
 *   1. Download the pre-populated template (server route streams XLSX).
 *   2. Upload the filled file.
 *
 * Semantics: replace-all. Every existing manualLineItems on the run
 * is wiped and rebuilt from the file. The admin sees the effect (and
 * a scary warning) before clicking Import.
 */
export function ImportPayrollAdjustmentsDialog({
  runId,
  periodLabel,
}: {
  runId: string
  periodLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [downloading, setDownloading] = useState(false)
  const { toast } = useToast()

  function resetAndClose() {
    setOpen(false)
    // Delay reset so the closing animation doesn't visibly flicker.
    setTimeout(() => {
      setFile(null)
      setResult(null)
      setImporting(false)
      setDownloading(false)
    }, 200)
  }

  async function handleDownloadTemplate() {
    setDownloading(true)
    try {
      const res = await fetch(
        `/admin/payroll/runs/${runId}/adjustments-template`,
        { cache: "no-store" },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        toast({
          title: `Could not download template — ${err?.error ?? "unknown error"}`,
          variant: "error",
        })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `payroll-adjustments-${periodLabel.replace(/\s+/g, "-").toLowerCase()}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      toast({
        title: "Could not download template. Please try again.",
        variant: "error",
      })
    } finally {
      setDownloading(false)
    }
  }

  async function handleImport() {
    if (!file) return
    setImporting(true)
    setResult(null)
    try {
      const fd = new FormData()
      fd.append("runId", runId)
      fd.append("file", file)
      const res = await importPayrollRunAdjustmentsAction(fd)
      setResult(res)
      if (res.status === "success") {
        toast({
          title: `Imported ${res.linesWritten} line${res.linesWritten === 1 ? "" : "s"} across ${res.employeesAffected} employee${res.employeesAffected === 1 ? "" : "s"}.`,
          variant: "success",
        })
      }
    } catch {
      setResult({
        status: "error",
        message: "Something went wrong. Please try again.",
      })
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetAndClose()
        else setOpen(true)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="rounded-xl">
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          Import adjustments
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import adjustments for {periodLabel}</DialogTitle>
          <DialogDescription>
            Upload an XLSX of one-off allowances / deductions /
            reimbursements. This <strong>replaces</strong> every existing
            manual adjustment on the run.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Step 1 — download the template */}
          <section className="rounded-xl border border-border/60 bg-surface-low p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Step 1 — Download the template
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Pre-populated with every eligible employee for this
                  month. Fill in the Category, Label, and Amount columns.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 rounded-lg"
                onClick={handleDownloadTemplate}
                disabled={downloading}
              >
                {downloading ? (
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                ) : (
                  <Download className="mr-2 h-3 w-3" />
                )}
                Template
              </Button>
            </div>
          </section>

          {/* Step 2 — upload the filled file */}
          <section className="rounded-xl border border-border/60 bg-surface-low p-3">
            <p className="text-sm font-medium text-foreground">
              Step 2 — Upload the filled file
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Employees are matched by full name — spelling must match
              their profile exactly. Any bad row rejects the whole file
              (no partial import).
            </p>
            <input
              type="file"
              accept=".xlsx"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null)
                setResult(null)
              }}
              className="mt-3 block w-full text-xs file:mr-3 file:rounded-lg file:border file:border-border/70 file:bg-background file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-surface-low"
            />
          </section>

          {result?.status === "error" && (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-destructive">
                  Import rejected
                </p>
                <p className="text-xs text-destructive/90">
                  {result.message}
                </p>
                {result.rowErrors && result.rowErrors.length > 0 && (
                  <ul className="mt-1 max-h-40 overflow-y-auto rounded-md bg-background/50 p-2 text-[11px] text-destructive/90">
                    {result.rowErrors.map((r) => (
                      <li key={r.rowNumber}>
                        Row {r.rowNumber}: {r.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {result?.status === "success" && (
            <div className="flex items-start gap-2 rounded-xl border border-emerald-300/60 bg-emerald-50/40 p-3 dark:border-emerald-700/40 dark:bg-emerald-950/20">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
              <div className="min-w-0 text-xs text-emerald-900 dark:text-emerald-200">
                <p className="font-medium">Imported.</p>
                <p>
                  {result.linesWritten} line
                  {result.linesWritten === 1 ? "" : "s"} written across{" "}
                  {result.employeesAffected} employee
                  {result.employeesAffected === 1 ? "" : "s"}.
                  {result.employeesWithoutFileEntry > 0 && (
                    <>
                      {" "}
                      {result.employeesWithoutFileEntry} employee
                      {result.employeesWithoutFileEntry === 1 ? "" : "s"} on
                      the run had their manual adjustments cleared (not in
                      file).
                    </>
                  )}{" "}
                  Re-run payroll to refresh the payslip totals.
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm">
              Close
            </Button>
          </DialogClose>
          <Button
            type="button"
            size="sm"
            onClick={handleImport}
            disabled={!file || importing}
          >
            {importing ? (
              <>
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                Importing…
              </>
            ) : (
              <>
                <Upload className="mr-2 h-3 w-3" />
                Import & replace
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
