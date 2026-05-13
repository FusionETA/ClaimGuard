"use client"

import { useMemo, useState } from "react"
import type { Route } from "next"
import Link from "next/link"
import { AlertTriangle, ChevronRight, CircleCheck, Search, Sliders } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { PayrollEmployeeRow } from "@/modules/payroll/domain/models"

type RunEmployeeRow = PayrollEmployeeRow & { ready: boolean }

type PayrollRunEmployeeTablesProps = {
  runId: string
  hasPayslips: boolean
  needsSetup: RunEmployeeRow[]
  readyEmployees: RunEmployeeRow[]
}

const ACTIVE_PAGE_SIZE = 10
const SETUP_PAGE_LIMIT = 5

export function PayrollRunEmployeeTables({
  runId,
  hasPayslips,
  needsSetup,
  readyEmployees,
}: PayrollRunEmployeeTablesProps) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const normalizedQuery = query.trim().toLowerCase()

  const filteredNeedsSetup = useMemo(
    () => filterEmployees(needsSetup, normalizedQuery),
    [needsSetup, normalizedQuery],
  )
  const filteredReady = useMemo(
    () => filterEmployees(readyEmployees, normalizedQuery),
    [readyEmployees, normalizedQuery],
  )

  const totalEmployees = needsSetup.length + readyEmployees.length
  if (totalEmployees === 0) return null

  const filteredTotal = filteredNeedsSetup.length + filteredReady.length
  const totalPages = getBalancedTotalPages(
    filteredNeedsSetup.length,
    filteredReady.length,
  )
  const currentPage = Math.min(page, totalPages)
  const paginatedEmployees = getBalancedPage(
    filteredNeedsSetup,
    filteredReady,
    currentPage,
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="relative w-full sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
              placeholder="Search employee, email, job title, or ID"
              className="h-10 pl-9"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Showing{" "}
            <span className="font-semibold text-foreground">{filteredTotal}</span>{" "}
            of <span className="font-semibold text-foreground">{totalEmployees}</span>{" "}
            employees
          </p>
        </CardContent>
      </Card>

      {paginatedEmployees.setup.length > 0 ? (
        <Card className="border-amber-300/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              {needsSetup.length} employee
              {needsSetup.length === 1 ? "" : "s"} need payroll setup
            </CardTitle>
            <CardDescription>
              These employees won&apos;t be included on this run until
              their payroll profile is complete.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <RunEmployeeTable
              employees={paginatedEmployees.setup}
              emptyText="No setup rows match your search."
              mode="setup"
            />
          </CardContent>
        </Card>
      ) : null}

      {paginatedEmployees.ready.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleCheck className="h-4 w-4 text-emerald-600" />
              {hasPayslips ? "Not yet on a payslip" : "Will be included"}
            </CardTitle>
            <CardDescription>
              {readyEmployees.length} employee
              {readyEmployees.length === 1 ? "" : "s"} ready for payroll.
              Run payroll to compute their payslips.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <RunEmployeeTable
              employees={paginatedEmployees.ready}
              emptyText="No ready employees match your search."
              mode="ready"
              runId={runId}
            />
          </CardContent>
        </Card>
      ) : null}

      <BalancedPaginationControls
        currentPage={currentPage}
        visibleItems={paginatedEmployees.setup.length + paginatedEmployees.ready.length}
        totalItems={filteredTotal}
        totalPages={totalPages}
        itemLabel="employees"
        onPageChange={setPage}
      />
    </div>
  )
}

function BalancedPaginationControls({
  currentPage,
  visibleItems,
  totalItems,
  totalPages,
  itemLabel,
  onPageChange,
}: {
  currentPage: number
  visibleItems: number
  totalItems: number
  totalPages: number
  itemLabel: string
  onPageChange: (page: number) => void
}) {
  if (totalPages <= 1) return null

  return (
    <div className="flex flex-col gap-3 rounded-3xl border border-border/70 bg-background/80 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-muted-foreground">
        Showing{" "}
        <span className="font-semibold text-foreground">{visibleItems}</span> of{" "}
        <span className="font-semibold text-foreground">{totalItems}</span>{" "}
        {itemLabel}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-full"
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
        >
          Previous
        </Button>
        <span className="text-sm font-medium text-foreground">
          Page {currentPage} of {totalPages}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-full"
          disabled={currentPage === totalPages}
          onClick={() => onPageChange(currentPage + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}

function getBalancedPage<T>(setupRows: T[], readyRows: T[], page: number) {
  let setupIndex = 0
  let readyIndex = 0
  let currentPage = 1

  while (currentPage < page) {
    const setupTake = Math.min(
      SETUP_PAGE_LIMIT,
      setupRows.length - setupIndex,
    )
    setupIndex += setupTake
    readyIndex += Math.min(
      ACTIVE_PAGE_SIZE - setupTake,
      readyRows.length - readyIndex,
    )
    currentPage += 1
  }

  const setupTake = Math.min(SETUP_PAGE_LIMIT, setupRows.length - setupIndex)
  const readyTake = Math.min(
    ACTIVE_PAGE_SIZE - setupTake,
    readyRows.length - readyIndex,
  )

  return {
    setup: setupRows.slice(setupIndex, setupIndex + setupTake),
    ready: readyRows.slice(readyIndex, readyIndex + readyTake),
  }
}

function getBalancedTotalPages(setupCount: number, readyCount: number) {
  let pages = 0
  let setupIndex = 0
  let readyIndex = 0

  while (setupIndex < setupCount || readyIndex < readyCount) {
    const setupTake = Math.min(SETUP_PAGE_LIMIT, setupCount - setupIndex)
    setupIndex += setupTake
    readyIndex += Math.min(ACTIVE_PAGE_SIZE - setupTake, readyCount - readyIndex)
    pages += 1
  }

  return Math.max(1, pages)
}

function RunEmployeeTable({
  employees,
  emptyText,
  mode,
  runId,
}: {
  employees: RunEmployeeRow[]
  emptyText: string
  mode: "setup" | "ready"
  runId?: string
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Employee</TableHead>
            <TableHead>Job title</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Employee ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {employees.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            employees.map((employee) => {
              const href =
                mode === "ready" && runId
                  ? (`/admin/payroll/runs/${runId}/employees/${employee.employeeProfileId}` as Route)
                  : (`/admin/payroll/employees/${employee.userId}` as Route)

              return (
                <TableRow key={employee.userId}>
                  <TableCell>
                    <Link
                      href={href}
                      className="font-bold text-foreground transition hover:text-primary"
                    >
                      {employee.name}
                    </Link>
                  </TableCell>
                  <TableCell>{employee.jobTitle}</TableCell>
                  <TableCell className="max-w-[260px] truncate text-muted-foreground">
                    {employee.email}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {employee.employeeId}
                  </TableCell>
                  <TableCell>
                    <RunEmployeeBadge employee={employee} mode={mode} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm" className="rounded-full">
                      <Link href={href}>
                        {mode === "ready" ? (
                          <>
                            Adjust
                            <Sliders className="ml-1 h-4 w-4" />
                          </>
                        ) : (
                          <>
                            Open
                            <ChevronRight className="ml-1 h-4 w-4" />
                          </>
                        )}
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function RunEmployeeBadge({
  employee,
  mode,
}: {
  employee: RunEmployeeRow
  mode: "setup" | "ready"
}) {
  if (mode === "ready") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-300/60 text-[10px] text-emerald-700"
      >
        Ready
      </Badge>
    )
  }

  return (
    <Badge
      variant="outline"
      className="border-amber-300/60 text-[10px] text-amber-700"
    >
      {employee.hasProfile ? "Incomplete" : "Not set up"}
    </Badge>
  )
}

function filterEmployees(employees: RunEmployeeRow[], query: string) {
  if (!query) return employees

  return employees.filter((employee) => {
    const haystack = [
      employee.name,
      employee.email,
      employee.employeeId,
      employee.jobTitle,
    ]
      .join(" ")
      .toLowerCase()

    return haystack.includes(query)
  })
}
