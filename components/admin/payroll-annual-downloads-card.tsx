"use client"

import { useState } from "react"
import { Download, FileText, Loader2 } from "lucide-react"

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
import { cn } from "@/lib/utils"
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
 * Year picker → list of report rows. Every download is rendered on
 * demand and streamed from `/admin/payroll/annual-forms/<year>/<kind>` —
 * nothing is stored on disk, so the forms always reflect the live
 * approved payroll year.
 */
export function PayrollAnnualDownloadsCard(props: {
  organizationName: string
  availableYears: number[]
  selectedYear: number
  rows: PayrollAnnualReportRow[]
  canGenerate: boolean
  submittedMonthCount: number
  missingMonths: number[]
  employerNoConfigured: boolean
}) {
  const { toast } = useToast()
  const [year, setYear] = useState<number>(props.selectedYear)
  const rows = props.rows
  const [pendingKind, setPendingKind] = useState<PayrollAnnualReportKind | null>(
    null,
  )

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

  async function handleDownload(kind: PayrollAnnualReportKind) {
    setPendingKind(kind)
    try {
      const res = await fetch(
        `/admin/payroll/annual-forms/${year}/${kind}`,
      )
      if (!res.ok) {
        toast({ title: await readErrorMessage(res), variant: "error" })
        return
      }
      const blob = await res.blob()
      const fileName = fileNameFromResponse(res, fallbackFileName(rows, kind))
      const url = URL.createObjectURL(blob)
      triggerDownload(url, fileName)
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
            Forms aggregate the full Jan-Dec approved payroll year.{" "}
            {!props.canGenerate
              ? `${props.submittedMonthCount}/12 monthly runs approved. Complete every month to enable downloads.`
              : null}
          </CardDescription>
          {!props.canGenerate && props.missingMonths.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Missing: {props.missingMonths.map(monthShortName).join(", ")}
            </p>
          ) : null}
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
function fallbackFileName(
  rows: PayrollAnnualReportRow[],
  kind: PayrollAnnualReportKind,
): string {
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

function monthShortName(month: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short" }).format(
    new Date(Date.UTC(2026, month - 1, 1)),
  )
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
