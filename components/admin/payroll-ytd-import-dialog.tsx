"use client"

import { useState } from "react"
import {
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react"

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

/**
 * Import payroll history — two-step modal:
 *
 *   1. Download the YTD template pre-filled with the org's employees.
 *   2. Upload the filled XLSX; the importer matches by NRIC / passport
 *      and writes historical runs marked source=IMPORTED (status
 *      SUBMITTED, immutable).
 *
 * Step 2 is intentionally wired but disabled in this commit — the
 * parser + commit logic ships next. The disabled state keeps the
 * full flow visible so admins know what to expect, instead of
 * surfacing a one-shot Download button that hides the upload half.
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
  const { toast } = useToast()

  const yearNum = Number(year)
  const yearValid =
    Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100

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
  }

  function handleImportClick() {
    // Stub — the parser + commit pipeline ships in the next update.
    // We surface a tracking toast so the admin knows the modal is the
    // right place to come back to.
    toast({
      title: "Upload coming with the next update.",
      variant: "success",
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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

        <div className="space-y-5 py-2">
          {/* Year picker — drives both the template filename and
              which calendar year the imported runs land under. */}
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
              already have a submitted run are skipped too — historical
              data is never overwritten.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={handleFileChange}
                className="max-w-xs"
              />
              <Button
                type="button"
                variant="default"
                className="gap-2"
                onClick={handleImportClick}
                disabled={!file || !yearValid}
              >
                <FileSpreadsheet className="h-4 w-4" />
                Import
              </Button>
            </div>
            {file && (
              <p className="text-[11px] text-muted-foreground">
                Selected: <span className="font-mono">{file.name}</span> (
                {Math.round(file.size / 1024)} KB)
              </p>
            )}
            <p className="rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              Upload is wired up — the parser + commit pipeline ships
              with the next update. Until then, downloading + filling
              the template is safe to do.
            </p>
          </section>
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
