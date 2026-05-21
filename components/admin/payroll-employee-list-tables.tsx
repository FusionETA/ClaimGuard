"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { AlertCircle, ChevronRight, CircleCheck, Search, UserPlus } from "lucide-react"

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

type PayrollState = "complete" | "incomplete" | "archived"

const ACTIVE_PAGE_SIZE = 10
const SETUP_PAGE_LIMIT = 5

export function PayrollEmployeeListTables({
  employees,
}: {
  employees: PayrollEmployeeRow[]
}) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const normalizedQuery = query.trim().toLowerCase()

  const complete = useMemo(
    () => employees.filter((employee) => employee.isComplete && !employee.isArchived),
    [employees],
  )
  const incomplete = useMemo(
    () => employees.filter((employee) => !employee.isComplete && !employee.isArchived),
    [employees],
  )
  const archived = useMemo(
    () => employees.filter((employee) => employee.isArchived),
    [employees],
  )

  const filteredComplete = useMemo(
    () => filterEmployees(complete, normalizedQuery),
    [complete, normalizedQuery],
  )
  const filteredIncomplete = useMemo(
    () => filterEmployees(incomplete, normalizedQuery),
    [incomplete, normalizedQuery],
  )
  const filteredArchived = useMemo(
    () => filterEmployees(archived, normalizedQuery),
    [archived, normalizedQuery],
  )

  if (employees.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4" />
            No employees yet
          </CardTitle>
          <CardDescription>
            Use the &ldquo;Add employee&rdquo; button above to create your
            first employee. You can fill in their projects, payroll, and
            statutory details from the profile tabs afterwards.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const filteredTotal =
    filteredComplete.length + filteredIncomplete.length + filteredArchived.length
  const activeTotal = filteredIncomplete.length + filteredComplete.length
  const totalPages = getBalancedTotalPages(
    filteredIncomplete.length,
    filteredComplete.length,
  )
  const currentPage = Math.min(page, totalPages)
  const paginatedEmployees = getBalancedPage(
    filteredIncomplete,
    filteredComplete,
    currentPage,
  )

  return (
    <div className="space-y-6">
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
            of <span className="font-semibold text-foreground">{employees.length}</span>{" "}
            employees
          </p>
        </CardContent>
      </Card>

      {paginatedEmployees.setup.length > 0 ? (
        <Card className="border-amber-300/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              {incomplete.length} employee
              {incomplete.length === 1 ? "" : "s"} need payroll setup
            </CardTitle>
            <CardDescription>
              These employees are missing statutory or compensation
              details. Click any row to complete their profile.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <EmployeeTable
              employees={paginatedEmployees.setup}
              emptyText="No setup rows match your search."
              state="incomplete"
            />
          </CardContent>
        </Card>
      ) : null}

      {paginatedEmployees.ready.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleCheck className="h-4 w-4 text-emerald-600" />
              Ready for payroll
            </CardTitle>
            <CardDescription>
              These employees have complete payroll profiles and will be
              included in the next payroll run.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <EmployeeTable
              employees={paginatedEmployees.ready}
              emptyText="No ready employees match your search."
              state="complete"
            />
          </CardContent>
        </Card>
      ) : null}

      {archived.length > 0 ? (
        <Card className="opacity-70">
          <CardHeader>
            <CardTitle className="text-base">Archived</CardTitle>
            <CardDescription>
              Excluded from new payroll runs. Click to view historical
              payslips or un-archive.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <EmployeeTable
              employees={filteredArchived}
              emptyText="No archived employees match your search."
              state="archived"
            />
          </CardContent>
        </Card>
      ) : null}

      <BalancedPaginationControls
        currentPage={currentPage}
        visibleItems={paginatedEmployees.setup.length + paginatedEmployees.ready.length}
        totalItems={activeTotal}
        totalPages={totalPages}
        itemLabel="active employees"
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

function EmployeeTable({
  employees,
  emptyText,
  state,
}: {
  employees: PayrollEmployeeRow[]
  emptyText: string
  state: PayrollState
}) {
  return (
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
            employees.map((employee) => (
              <TableRow key={employee.userId}>
                <TableCell>
                  <Link
                    href={`/admin/payroll/employees/${employee.userId}`}
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
                  <PayrollStatusBadge employee={employee} state={state} />
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="ghost" size="sm" className="rounded-full">
                    <Link href={`/admin/payroll/employees/${employee.userId}`}>
                      Open
                      <ChevronRight className="ml-1 h-4 w-4" />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
    </Table>
  )
}

function PayrollStatusBadge({
  employee,
  state,
}: {
  employee: PayrollEmployeeRow
  state: PayrollState
}) {
  if (state === "complete") {
    // Salary = 0 is an intentional opt-out — render a neutral grey
    // "Excluded" chip so admins can tell at a glance that this person
    // is set up correctly but won't be picked up by payroll runs.
    if (employee.isExcluded) {
      return (
        <Badge
          variant="outline"
          className="border-slate-300/60 text-[10px] text-slate-600"
          title="Salary set to 0 — excluded from payroll runs"
        >
          Excluded
        </Badge>
      )
    }
    return (
      <Badge
        variant="outline"
        className="border-emerald-300/60 text-[10px] text-emerald-700"
      >
        Ready
      </Badge>
    )
  }

  if (state === "incomplete") {
    return (
      <Badge
        variant="outline"
        className="border-amber-300/60 text-[10px] text-amber-700"
      >
        {employee.hasProfile ? "Incomplete" : "Not set up"}
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className="text-[10px]">
      Archived
    </Badge>
  )
}

function filterEmployees(employees: PayrollEmployeeRow[], query: string) {
  if (!query) return employees

  return employees.filter((employee) => {
    const haystack = [
      employee.name,
      employee.email,
      employee.employeeId,
      employee.jobTitle,
      employee.hasProfile ? "incomplete" : "not set up",
      employee.isComplete && !employee.isExcluded ? "ready" : "",
      employee.isExcluded ? "excluded" : "",
      employee.isArchived ? "archived" : "",
    ]
      .join(" ")
      .toLowerCase()

    return haystack.includes(query)
  })
}
