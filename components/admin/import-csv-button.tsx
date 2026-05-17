"use client"

import { useActionState, useRef, useState } from "react"
import { Download, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
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

import type { ImportCsvActionResult } from "@/app/(admin)/admin/settings/actions"

type CsvImportAction = (
  prev: ImportCsvActionResult | null,
  formData: FormData,
) => Promise<ImportCsvActionResult>

/**
 * Reusable bulk-import dialog. Pick a CSV, hit "Import", see counts
 * and per-row errors. Same UX for COA and projects — only the
 * server action + template differ.
 *
 * The template download is a data: URL so we don't need a route or a
 * static asset for what's effectively just a header row.
 */
export function ImportCsvButton({
  buttonLabel,
  dialogTitle,
  dialogDescription,
  action,
  templateFilename,
  templateCsv,
  exampleRows,
}: {
  buttonLabel: string
  dialogTitle: string
  dialogDescription: string
  action: CsvImportAction
  /** Suggested filename when the admin clicks "Download template". */
  templateFilename: string
  /** CSV header row text (no trailing newline). */
  templateCsv: string
  /**
   * Short list of example rows (label + body) rendered under the file
   * picker so the admin sees the expected shape without downloading.
   */
  exampleRows: ReadonlyArray<string>
}) {
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState<
    ImportCsvActionResult | null,
    FormData
  >(action, null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pickedFileName, setPickedFileName] = useState<string | null>(null)
  const { toast } = useToast()

  function reset() {
    setPickedFileName(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function handleDownloadTemplate() {
    const blob = new Blob([templateCsv + "\n"], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = templateFilename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <Upload className="mr-1.5 h-4 w-4" />
          {buttonLabel}
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        <form
          action={(fd) => {
            formAction(fd)
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="import-csv-file">CSV file</Label>
            <Input
              ref={fileInputRef}
              id="import-csv-file"
              name="file"
              type="file"
              accept=".csv,text/csv"
              required
              onChange={(e) => setPickedFileName(e.target.files?.[0]?.name ?? null)}
            />
            {pickedFileName ? (
              <p className="text-xs text-muted-foreground">Selected: {pickedFileName}</p>
            ) : null}
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
            <p className="font-semibold text-foreground">Expected format</p>
            <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
              {exampleRows.map((row, idx) => (
                <li key={idx} className="font-mono">{row}</li>
              ))}
            </ul>
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              <Download className="h-3 w-3" />
              Download template
            </button>
          </div>

          {state?.status === "error" ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {state.message}
            </p>
          ) : null}

          {state?.status === "success" ? (
            <ImportSummary
              result={state}
              onClose={() => {
                if (state.imported > 0) {
                  toast({
                    title: `Imported ${state.imported} row${state.imported === 1 ? "" : "s"}.`,
                    variant: "success",
                  })
                }
                setOpen(false)
                reset()
              }}
            />
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false)
                reset()
              }}
            >
              {state?.status === "success" ? "Close" : "Cancel"}
            </Button>
            <Button type="submit" disabled={pending || state?.status === "success"}>
              {pending ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ImportSummary({
  result,
  onClose,
}: {
  result: { imported: number; skipped: number; errors: Array<{ row: number; message: string }> }
  onClose: () => void
}) {
  const hasErrors = result.errors.length > 0
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs",
        hasErrors
          ? "border-amber-300/60 bg-amber-50 text-amber-900"
          : "border-emerald-300/60 bg-emerald-50 text-emerald-900",
      )}
    >
      <p className="font-semibold">
        Imported {result.imported} · Skipped {result.skipped} · Errors {result.errors.length}
      </p>
      {hasErrors ? (
        <ul className="mt-1.5 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-4">
          {result.errors.slice(0, 25).map((e, idx) => (
            <li key={idx}>
              Row {e.row}: {e.message}
            </li>
          ))}
          {result.errors.length > 25 ? (
            <li>… and {result.errors.length - 25} more.</li>
          ) : null}
        </ul>
      ) : null}
      {!hasErrors ? (
        <button
          type="button"
          onClick={onClose}
          className="mt-1.5 text-[11px] font-semibold underline"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  )
}
