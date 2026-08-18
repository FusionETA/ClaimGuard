"use client"

import { useMemo, useState, useTransition } from "react"
import { AlertTriangle, Download, FileUp, Info } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  toHrBalanceCsv,
  type ConvertedRow,
  type ConvertedStatus,
} from "@/modules/leave/domain/payroll-panda-balances"

import { convertPayrollPandaBalancesAction } from "./actions"
import type { ConvertResponse } from "./types"

/// Status → how it reads in the preview. Everything that isn't READY
/// needs a human, so each one says what to do rather than just naming a
/// failure.
const STATUS_META: Record<
  ConvertedStatus,
  { label: string; tone: string; hint: string }
> = {
  READY: {
    label: "Ready",
    tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    hint: "Included in the download.",
  },
  NO_EMAIL_MATCH: {
    label: "No match",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    hint: "No employee of that name in AltomateHR. Add them first, or add the email to the CSV by hand.",
  },
  AMBIGUOUS_NAME: {
    label: "Ambiguous",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    hint: "More than one employee shares this name — pick the right email by hand.",
  },
  UNKNOWN_LEAVE_TYPE: {
    label: "No leave type",
    tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    hint: "Create the matching leave type under Leave → Settings, then convert again.",
  },
  EMPTY: {
    label: "Empty",
    tone: "border-muted-foreground/30 bg-muted text-muted-foreground",
    hint: "Every figure is zero — nothing to migrate. Tick “include empty rows” if you want them anyway.",
  },
}

const STATUS_ORDER: ConvertedStatus[] = [
  "READY",
  "NO_EMAIL_MATCH",
  "AMBIGUOUS_NAME",
  "UNKNOWN_LEAVE_TYPE",
  "EMPTY",
]

export function LeaveBalanceConverterClient() {
  const [result, setResult] = useState<ConvertResponse | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [showOnlyProblems, setShowOnlyProblems] = useState(false)

  const data = result?.data
  const rows = useMemo(() => data?.rows ?? [], [data])

  const counts = useMemo(() => {
    const out = {} as Record<ConvertedStatus, number>
    for (const s of STATUS_ORDER) out[s] = 0
    for (const r of rows) out[r.status] += 1
    return out
  }, [rows])

  const visibleRows = useMemo(
    () => (showOnlyProblems ? rows.filter((r) => r.status !== "READY") : rows),
    [rows, showOnlyProblems],
  )

  function onSubmit(formData: FormData) {
    startTransition(async () => {
      setResult(await convertPayrollPandaBalancesAction(formData))
    })
  }

  function downloadCsv() {
    if (!data) return
    const csv = toHrBalanceCsv(rows)
    // Prepend a BOM so Excel opens the UTF-8 names correctly.
    const blob = new Blob(["﻿" + csv], {
      type: "text/csv;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `leave-balances-${data.year}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Upload the export</CardTitle>
          <CardDescription>
            The .xlsx straight from Payroll Panda. The Days sheet is used;
            an Hours-only export can’t be converted without knowing the
            working day length.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={onSubmit} className="flex flex-col gap-4">
            <input
              type="file"
              name="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
              className="block w-full max-w-xl text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
            />
            <label className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" name="includeEmptyRows" className="h-4 w-4" />
              Include rows where every figure is zero
            </label>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={pending}>
                <FileUp className="mr-1.5 h-4 w-4" />
                {pending ? "Converting…" : "Convert"}
              </Button>
              {fileName ? (
                <span className="truncate text-sm text-muted-foreground">
                  {fileName}
                </span>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {result && !result.ok ? (
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-2 pt-6 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>{result.message}</span>
          </CardContent>
        </Card>
      ) : null}

      {data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">2. Check the result</CardTitle>
              <CardDescription>
                {data.companyName ?? "Unknown company"} · sheet “{data.sheetName}”
                {data.memberCount != null ? ` · ${data.memberCount} members` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border p-3">
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Balances as at
                  </dt>
                  <dd className="mt-0.5 font-medium tabular-nums">
                    {data.asAtDate ?? "—"}
                  </dd>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Enter this exact date in the importer.
                  </p>
                </div>
                <div className="rounded-md border p-3">
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Entitlement year
                  </dt>
                  <dd className="mt-0.5 font-medium tabular-nums">{data.year}</dd>
                </div>
                <div className="rounded-md border p-3">
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Unit
                  </dt>
                  <dd className="mt-0.5 font-medium">{data.unit ?? "—"}</dd>
                </div>
              </dl>

              {data.problems.length > 0 ? (
                <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  {data.problems.map((p, i) => (
                    <p key={i} className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      <span>{p}</span>
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
                  <span
                    key={s}
                    className={cn(
                      "rounded-md border px-2 py-1 text-xs font-medium tabular-nums",
                      STATUS_META[s].tone,
                    )}
                  >
                    {counts[s]} {STATUS_META[s].label}
                  </span>
                ))}
              </div>

              {counts.READY < rows.length ? (
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  Only the “Ready” rows are written to the CSV. Fix the rest in
                  AltomateHR and convert again, or edit the downloaded file by
                  hand.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
              <div>
                <CardTitle className="text-base">3. Download &amp; import</CardTitle>
                <CardDescription>
                  Upload the CSV at Leave → Import, with “balances as at” set to{" "}
                  {data.asAtDate ?? "the export date"}.
                </CardDescription>
              </div>
              <Button onClick={downloadCsv} disabled={counts.READY === 0}>
                <Download className="mr-1.5 h-4 w-4" />
                Download {counts.READY} rows
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showOnlyProblems}
                  onChange={(e) => setShowOnlyProblems(e.target.checked)}
                  className="h-4 w-4"
                />
                Show only rows needing attention
              </label>

              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-14">Row</TableHead>
                      <TableHead>Employee</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Leave type</TableHead>
                      <TableHead className="text-right">Entitled</TableHead>
                      <TableHead className="text-right">Carried</TableHead>
                      <TableHead className="text-right">Taken</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.map((row) => (
                      <ConverterRow key={`${row.sheetRow}-${row.policy}`} row={row} />
                    ))}
                    {visibleRows.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={8}
                          className="text-center text-sm text-muted-foreground"
                        >
                          Nothing to show.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}

function ConverterRow({ row }: { row: ConvertedRow }) {
  const meta = STATUS_META[row.status]
  return (
    <TableRow className={row.status === "EMPTY" ? "opacity-60" : undefined}>
      <TableCell className="tabular-nums text-muted-foreground">
        {row.sheetRow}
      </TableCell>
      <TableCell>
        <div className="font-medium">{row.fullName || "—"}</div>
        {row.memberCode ? (
          <div className="text-xs text-muted-foreground">{row.memberCode}</div>
        ) : null}
      </TableCell>
      <TableCell className="text-sm">
        {row.email ?? <span className="text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-sm">
        {row.leaveTypeName ?? (
          <span className="text-muted-foreground">{row.policy}</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.entitled}</TableCell>
      <TableCell className="text-right tabular-nums">
        {row.carriedForward}
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.taken}</TableCell>
      <TableCell>
        <Badge variant="outline" className={cn("font-normal", meta.tone)}>
          {meta.label}
        </Badge>
        {row.notes.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {row.notes.map((n, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                {n}
              </li>
            ))}
          </ul>
        ) : null}
      </TableCell>
    </TableRow>
  )
}
