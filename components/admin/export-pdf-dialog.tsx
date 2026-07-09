"use client"

import { useState, useMemo } from "react"
import { Search } from "lucide-react"

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
import { ScrollArea } from "@/components/ui/scroll-area"

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
  const { employees } = props

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const allSelected = selectedIds.size === employees.length && employees.length > 0

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

  function handleDownload() {
    if (!canDownload()) return
    window.open(buildUrl(), "_blank", "noopener,noreferrer")
    setOpen(false)
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

        <div className="flex flex-1 flex-col gap-4 overflow-hidden px-6 py-4">
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
          <div className="flex flex-1 flex-col gap-2 overflow-hidden">
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

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
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

            {/* Employee list */}
            <ScrollArea className="flex-1 rounded-md border border-border">
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
            </ScrollArea>
          </div>
        </div>

        <div className="shrink-0 border-t px-6 py-4">
          <Button
            onClick={handleDownload}
            disabled={!canDownload()}
            className="w-full"
          >
            Download PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
