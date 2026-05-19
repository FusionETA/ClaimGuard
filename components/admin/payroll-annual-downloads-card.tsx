"use client"

import * as React from "react"
import { useState, useTransition } from "react"
import { Download, FileText, Loader2 } from "lucide-react"

import { generatePayrollAnnualReportAction } from "@/app/(admin)/admin/payroll/annual-forms/actions"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/toaster"
import { cn, formatShortDate } from "@/lib/utils"
import {
  PAYROLL_ANNUAL_REPORT_GROUP_LABELS,
  type PayrollAnnualReportGroup,
  type PayrollAnnualReportKind,
  type PayrollAnnualReportRow,
} from "@/modules/payroll/domain/annual-reports"

/**
 * The downloads card on the Annual Tax Forms page. Mirrors the per-run
 * modal pattern but renders inline (no modal wrapping) since the page
 * is dedicated to this one task.
 *
 * Year picker → list of report rows. First download click renders +
 * caches; later clicks serve from cache.
 */
export function PayrollAnnualDownloadsCard(props: {
  organizationName: string
  availableYears: number[]
  selectedYear: number
  rows: PayrollAnnualReportRow[]
  canGenerate: boolean
  employerNoConfigured: boolean
}) {
  const { toast } = useToast()
  const [year, setYear] = useState<number>(props.selectedYear)
  const [rows, setRows] = useState(props.rows)
  const [pendingKind, setPendingKind] = useState<PayrollAnnualReportKind | null>(
    null,
  )
  const [, startTransition] = useTransition()

  // Keep local rows synced with year selection. When the user changes
  // year, we ask the server to re-fetch via a soft refresh.
  React.useEffect(() => {
    setRows(props.rows)
  }, [props.rows])

  function handleYearChange(newYear: string) {
    const parsed = Number(newYear)
    if (!Number.isFinite(parsed)) return
    setYear(parsed)
    // Push to the URL so the server component re-renders with the
    // matching year's data.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set("year", String(parsed))
      window.location.href = url.toString()
    }
  }

  function handleDownload(kind: PayrollAnnualReportKind) {
    setPendingKind(kind)
    startTransition(async () => {
      try {
        const result = await generatePayrollAnnualReportAction({
          year,
          kind,
        })
        if (result.status === "error") {
          toast({ title: result.message, variant: "error" })
          return
        }
        triggerDownload(result.fileUrl, result.fileName)
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

  const grouped: Record<PayrollAnnualReportGroup, PayrollAnnualReportRow[]> = {
    FORMS: rows.filter((r) => r.group === "FORMS"),
    LHDN_TXT: rows.filter((r) => r.group === "LHDN_TXT"),
  }

  const showEmployerNoWarning =
    !props.employerNoConfigured && props.canGenerate

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Annual Tax Forms — {year}</CardTitle>
          <CardDescription className="mt-2">
            {props.organizationName ? `${props.organizationName} · ` : ""}
            Forms aggregating every SUBMITTED payroll run in the calendar
            year.{" "}
            {!props.canGenerate
              ? "No SUBMITTED runs in this year yet. Submit + approve at least one run to enable downloads."
              : null}
          </CardDescription>
        </div>
        <div className="shrink-0">
          <Select value={String(year)} onValueChange={handleYearChange}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Year" />
            </SelectTrigger>
            <SelectContent>
              {props.availableYears.length === 0 ? (
                <SelectItem value={String(year)} disabled>
                  {year} (no data)
                </SelectItem>
              ) : (
                props.availableYears.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {showEmployerNoWarning ? (
          <div className="rounded-xl border border-amber-300/60 bg-amber-50/40 p-3 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-200">
            Employer LHDN E-number is missing. Set{" "}
            <strong>Payroll Settings → Company Info → Employer TIN</strong>{" "}
            before generating the CP8D TXT files — the PDFs will still
            generate without it.
          </div>
        ) : null}

        {(["FORMS", "LHDN_TXT"] as const).map((group) => {
          const groupRows = grouped[group]
          if (groupRows.length === 0) return null
          return (
            <section key={group} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {PAYROLL_ANNUAL_REPORT_GROUP_LABELS[group]}
              </h3>
              <ul className="space-y-1.5">
                {groupRows.map((row) => (
                  <AnnualRow
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
      </CardContent>
    </Card>
  )
}

function AnnualRow(props: {
  row: PayrollAnnualReportRow
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function triggerDownload(url: string, fileName: string) {
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  a.rel = "noopener"
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}
