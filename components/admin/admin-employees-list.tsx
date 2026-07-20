"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ChevronRight, Search } from "lucide-react"

import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { Input } from "@/components/attendance/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PaginationControls } from "@/components/ui/pagination-controls"
import { HoursProgressInline } from "@/components/attendance/hours-progress"
import { attendanceStatusMeta } from "@/modules/attendance/domain/metadata"
import type { AttendanceStatus } from "@/modules/attendance/domain/models"

const PAGE_SIZE = 20

type Employee = {
  id: string
  name: string
  email: string
  role: string
  initials: string
  jobTitle: string | null
  project: string | null
  todayStatus: AttendanceStatus | null
  todayTimeIn: string | null
  monthActualMin: number
  monthExpectedMin: number
}

const STATUS_VARIANT: Record<string, string> = {
  ON_TIME: "on-time",
  LATE: "late",
  MISSING: "missing",
  ON_LEAVE: "on-leave",
  CLOCKED_IN: "clocked-in",
  CLOCKED_OUT: "clocked-out",
}

const ALL_PROJECTS = "ALL"

function fmtTime(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    : "—"
}

export function AdminEmployeesList({ employees }: { employees: Employee[] }) {
  const [searchTerm, setSearchTerm] = useState("")
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS)

  const projectOptions = useMemo(() => {
    const set = new Set<string>()
    for (const e of employees) {
      if (e.project) set.add(e.project)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [employees])

  const filteredEmployees = useMemo(() => {
    const normalized = searchTerm.trim().toLowerCase()
    return employees.filter((e) => {
      const matchesName = normalized.length === 0 || e.name.toLowerCase().includes(normalized)
      const matchesProject =
        projectFilter === ALL_PROJECTS || e.project === projectFilter
      return matchesName && matchesProject
    })
  }, [employees, searchTerm, projectFilter])

  const isFiltered =
    searchTerm.trim().length > 0 || projectFilter !== ALL_PROJECTS

  // Pagination. Reset to page 1 whenever the filter set changes so the
  // user isn't stranded on a page number that no longer exists after
  // narrowing/expanding the visible set.
  const [page, setPage] = useState(1)
  useEffect(() => {
    setPage(1)
  }, [searchTerm, projectFilter])
  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / PAGE_SIZE))
  const clampedPage = Math.min(page, totalPages)
  const pagedEmployees = useMemo(
    () =>
      filteredEmployees.slice(
        (clampedPage - 1) * PAGE_SIZE,
        clampedPage * PAGE_SIZE,
      ),
    [filteredEmployees, clampedPage],
  )

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {isFiltered
            ? `${filteredEmployees.length} of ${employees.length} people`
            : `${employees.length} people`}
        </p>
        <h2 className="mt-0.5 font-headline text-2xl font-bold text-foreground">
          Employees
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_220px] sm:gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search by name"
            className="pl-10"
          />
        </div>

        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
            {projectOptions.map((project) => (
              <SelectItem key={project} value={project}>
                {project}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-3">
          {employees.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No employees in this organisation yet.
            </p>
          ) : filteredEmployees.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No employees match the current filters.
            </p>
          ) : (
            <div className="space-y-1">
              {pagedEmployees.map((e) => (
                <Link
                  key={e.id}
                  href={`/admin/attendance/employees/${e.id}`}
                  className="flex items-center gap-3 rounded-xl border border-transparent px-2 py-2 transition hover:border-border/60 hover:bg-secondary/30"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {e.name}
                      </p>
                      <Badge
                        variant={e.role === "SUPERVISOR" ? "overtime" : "outline"}
                        className="text-[9px]"
                      >
                        {e.role}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {e.jobTitle ?? "—"}
                      {e.project ? ` • ${e.project}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div
                      className="hidden text-right md:block"
                      title="Actual / expected hours this month"
                    >
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Hours (month)
                      </p>
                      <HoursProgressInline
                        entry={{
                          actualMin: e.monthActualMin,
                          expectedMin: e.monthExpectedMin,
                        }}
                      />
                    </div>
                    {e.todayStatus ? (
                      <div className="hidden text-right sm:block">
                        <Badge variant={STATUS_VARIANT[e.todayStatus] as never}>
                          {attendanceStatusMeta[e.todayStatus].label}
                        </Badge>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {fmtTime(e.todayTimeIn)}
                        </p>
                      </div>
                    ) : (
                      <span className="hidden text-[10px] text-muted-foreground sm:inline">
                        no clock-in
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </div>
                </Link>
              ))}
            </div>
          )}
          <PaginationControls
            className="mt-3 flex flex-col items-start justify-between gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center"
            currentPage={clampedPage}
            pageSize={PAGE_SIZE}
            totalItems={filteredEmployees.length}
            itemLabel="employees"
            onPageChange={setPage}
          />
        </CardContent>
      </Card>
    </div>
  )
}
