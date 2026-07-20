"use client"

import { useState, useMemo } from "react"
import { Loader2, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toaster"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExportEmployee {
  id: string
  name: string
}

type AttendanceMode = {
  kind: "attendance"
  initialFrom: string
  initialTo: string
}

type LeaveMode = {
  kind: "leave"
  initialYear: number
}

export type ExportPdfDialogProps = {
  employees: ExportEmployee[]
  children?: React.ReactNode
} & (AttendanceMode | LeaveMode)

// ─── Component ────────────────────────────────────────────────────────────────

export function ExportPdfDialog(props: ExportPdfDialogProps) {
  // Callers occasionally pass duplicate ids — e.g. the leave balances
  // page pulls from listAllEmployeeBalancesForOrg which can surface the
  // same userId twice if a user has multiple EmployeeProfile rows in
  // the same org. Dedupe here so every consumer is safe from the
  // React "same key" warning and the map()->checkbox flow doesn't
  // render broken duplicate rows.
  const employees = useMemo(() => {
    const seen = new Set<string>()
    const out: ExportEmployee[] = []
    for (const e of props.employees) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      out.push(e)
    }
    return out
  }, [props.employees])

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [downloading, setDownloading] = useState(false)
  const allSelected = selectedIds.size === employees.length && employees.length > 0
  const { toast } = useToast()

  const [from, setFrom] = useState(
    props.kind === "attendance" ? props.initialFrom : "",
  )
  const [to, setTo] = useState(
    props.kind === "attendance" ? props.initialTo : "",
  )
  const [year, setYear] = useState(
    props.kind === "leave" ? String(props.initialYear) : String(new Date().getUTCFullYear()),
  )

  const filtered = useMemo(
    () =>
      search.trim()
        ? employees.filter((e) =>
            e.name.toLowerCase().includes(search.toLowerCase()),
          )
        : employees,
    [employees, search],
  )

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(employees.map((e) => e.id)))
    }
  }

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function buildUrl(): string {
    // No employees selected = export all
    const ids =
      selectedIds.size > 0 && selectedIds.size < employees.length
        ? [...selectedIds].join(",")
        : undefined

    if (props.kind === "attendance") {
      const params = new URLSearchParams({ from, to })
      if (ids) params.set("employeeIds", ids)
      if (selectedIds.size === 1) {
        // single employee → per-employee route
        const empId = [...selectedIds][0]
        return `/api/admin/export/attendance-report?employeeId=${empId}&from=${from}&to=${to}`
      }
      return `/api/admin/export/attendance-report-bulk?${params.toString()}`
    } else {
      const params = new URLSearchParams({ year })
      if (ids) params.set("employeeIds", ids)
      if (selectedIds.size === 1) {
        const empId = [...selectedIds][0]
        return `/api/admin/export/leave-summary?employeeId=${empId}&year=${year}`
      }
      return `/api/admin/export/leave-summary-bulk?${params.toString()}`
    }
  }

  function canDownload(): boolean {
    if (props.kind === "attendance") return !!(from && to && from <= to)
    const y = parseInt(year, 10)
    return !isNaN(y) && y >= 2000 && y <= 2100
  }

  async function handleDownload() {
    if (!canDownload() || downloading) return
    setDownloading(true)
    try {
      // Fetch the file ourselves (instead of `a.click()` and hoping)
      // so we can show a spinner + disabled button while the server
      // renders. Bulk ZIPs can take 60-90s for 190-employee runs;
      // without this the modal used to close instantly and the admin
      // had no indication anything was happening.
      const response = await fetch(buildUrl(), {
        method: "GET",
        credentials: "same-origin",
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        toast({
          title:
            body?.error ??
            `Download failed (HTTP ${response.status}).`,
          variant: "error",
        })
        return
      }
      // Pull filename out of Content-Disposition; the server sends
      // e.g. `attachment; filename="attendance-reports-...zip"`.
      const cd = response.headers.get("Content-Disposition") ?? ""
      const match = cd.match(/filename="?([^";]+)"?/i)
      const filename = match?.[1] ?? "download"
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
      setOpen(false)
    } catch (err) {
      toast({
        title:
          err instanceof Error
            ? err.message
            : "Download failed. Please try again.",
        variant: "error",
      })
    } finally {
      setDownloading(false)
    }
  }

  const indeterminate = selectedIds.size > 0 && selectedIds.size < employees.length

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {props.children ?? (
          <button
            type="button"
            className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            Export PDF
          </button>
        )}
      </DialogTrigger>

      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>Export PDF Report</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-4">
          {/* Date / Year controls */}
          {props.kind === "attendance" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">From</Label>
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">To</Label>
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Year</Label>
              <Input
                type="number"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                min={2000}
                max={2100}
                className="h-8 w-32 text-sm"
              />
            </div>
          )}

          {/* Employee picker */}
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Employees
              </span>
              <span className="text-xs text-muted-foreground">
                {selectedIds.size === 0
                  ? "All employees"
                  : `${selectedIds.size} selected`}
              </span>
            </div>

            {/* Search — px-1 gutter so the focus ring isn't clipped by
                the parent's overflow-hidden (see components/CLAUDE.md). */}
            <div className="relative px-1">
              <Search className="absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search employees…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-sm"
              />
            </div>

            {/* Select all row */}
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 hover:bg-muted">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = indeterminate }}
                onChange={toggleAll}
                className="h-4 w-4 shrink-0 accent-primary"
              />
              <span className="text-sm font-medium">
                {allSelected ? "Deselect all" : "Select all"}
              </span>
            </label>

            {/* Employee list — plain scrollable div (not the shared
                ScrollArea component, whose outer .relative wrapper
                has no height and swallows the parent's `flex-1`
                allocation, leaving nothing to scroll). */}
            <div className="nice-scrollbar min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
              <div className="divide-y">
                {filtered.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    No employees match.
                  </p>
                ) : (
                  filtered.map((emp) => (
                    <label
                      key={emp.id}
                      className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(emp.id)}
                        onChange={() => toggle(emp.id)}
                        className="h-4 w-4 shrink-0 accent-primary"
                      />
                      <span className="text-sm">{emp.name}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t px-6 py-4">
          <Button
            onClick={handleDownload}
            disabled={!canDownload() || downloading}
            className="w-full gap-2"
          >
            {downloading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Downloading…
              </>
            ) : (
              "Download PDF"
            )}
          </Button>
          {downloading ? (
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              Rendering per-employee PDFs — this can take up to a
              minute for large selections. Keep this dialog open.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
