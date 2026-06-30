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
import { cn } from "@/lib/utils"
import type { PayrollEmployeeRow } from "@/modules/payroll/domain/models"

type PayrollState = "complete" | "incomplete" | "archived"

// Each section paginates independently — admins kept asking why
// flipping past page 1 hid Ready rows behind a single shared paginator
// when Needs-setup ran long, so the two lists no longer share a page
// counter. 10 rows per section keeps the on-screen density manageable
// without making admins click Next on every other row.
const PAGE_SIZE = 10

export function PayrollEmployeeListTables({
  employees,
}: {
  employees: PayrollEmployeeRow[]
}) {
  const [query, setQuery] = useState("")
  const [setupPage, setSetupPage] = useState(1)
  const [readyPage, setReadyPage] = useState(1)
  // Active vs Archived tab. Defaults to Active so admins land on the
  // employees that affect the upcoming payroll run. Archived list lives
  // behind its own tab so admins don't accidentally scroll past their
  // working set of active employees to reach it.
  const [activeTab, setActiveTab] = useState<"active" | "archived">("active")
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

  const activeCount = complete.length + incomplete.length
  const archivedCount = archived.length
  const filteredActiveTotal =
    filteredComplete.length + filteredIncomplete.length
  const filteredTotal =
    activeTab === "active" ? filteredActiveTotal : filteredArchived.length
  const tabbedTotalCount =
    activeTab === "active" ? activeCount : archivedCount

  const setupTotalPages = Math.max(
    1,
    Math.ceil(filteredIncomplete.length / PAGE_SIZE),
  )
  const setupCurrentPage = Math.min(setupPage, setupTotalPages)
  const setupSliceStart = (setupCurrentPage - 1) * PAGE_SIZE
  const setupSlice = filteredIncomplete.slice(
    setupSliceStart,
    setupSliceStart + PAGE_SIZE,
  )

  const readyTotalPages = Math.max(
    1,
    Math.ceil(filteredComplete.length / PAGE_SIZE),
  )
  const readyCurrentPage = Math.min(readyPage, readyTotalPages)
  const readySliceStart = (readyCurrentPage - 1) * PAGE_SIZE
  const readySlice = filteredComplete.slice(
    readySliceStart,
    readySliceStart + PAGE_SIZE,
  )

  const tabs: Array<{
    value: "active" | "archived"
    label: string
    count: number
  }> = [
    { value: "active", label: "Active", count: activeCount },
    { value: "archived", label: "Archived", count: archivedCount },
  ]

  return (
    <div className="space-y-6">
      {/* Active vs Archived tab strip. Pill style — matches the
          settings page's mobile sub-nav. Counts shown so admins can
          tell at a glance how many sit in each bucket. */}
      <div className="flex gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => {
              setActiveTab(tab.value)
              setSetupPage(1)
              setReadyPage(1)
            }}
            className={cn(
              "shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors",
              activeTab === tab.value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            <span
              className={cn(
                "ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                activeTab === tab.value
                  ? "bg-primary-foreground/20 text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="relative w-full sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setSetupPage(1)
                setReadyPage(1)
              }}
              placeholder="Search employee, email, job title, or ID"
              className="h-10 pl-9"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Showing{" "}
            <span className="font-semibold text-foreground">{filteredTotal}</span>{" "}
            of <span className="font-semibold text-foreground">{tabbedTotalCount}</span>{" "}
            {activeTab === "active" ? "active" : "archived"} employee
            {tabbedTotalCount === 1 ? "" : "s"}
          </p>
        </CardContent>
      </Card>

      {activeTab === "active" && filteredIncomplete.length > 0 ? (
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
              employees={setupSlice}
              emptyText="No setup rows match your search."
              state="incomplete"
            />
          </CardContent>
          <SectionPaginationControls
            currentPage={setupCurrentPage}
            totalItems={filteredIncomplete.length}
            totalPages={setupTotalPages}
            sliceStart={setupSliceStart}
            sliceEnd={setupSliceStart + setupSlice.length}
            itemLabel="needs setup"
            onPageChange={setSetupPage}
          />
        </Card>
      ) : null}

      {activeTab === "active" && filteredComplete.length > 0 ? (
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
              employees={readySlice}
              emptyText="No ready employees match your search."
              state="complete"
            />
          </CardContent>
          <SectionPaginationControls
            currentPage={readyCurrentPage}
            totalItems={filteredComplete.length}
            totalPages={readyTotalPages}
            sliceStart={readySliceStart}
            sliceEnd={readySliceStart + readySlice.length}
            itemLabel="ready for payroll"
            onPageChange={setReadyPage}
          />
        </Card>
      ) : null}

      {activeTab === "archived" && archived.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Archived employees</CardTitle>
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

      {/* Empty-tab hint: tab is selected but there's nothing in it.
          Without this the page just looks blank below the tab strip. */}
      {activeTab === "active" &&
      filteredIncomplete.length === 0 &&
      filteredComplete.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No active employees</CardTitle>
            <CardDescription>
              {query.trim().length > 0
                ? "No active employees match your search."
                : "All employees are archived. Switch to the Archived tab to view them."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {activeTab === "archived" && archived.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No archived employees</CardTitle>
            <CardDescription>
              When you archive an employee from their profile page they
              show up here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}
    </div>
  )
}

/**
 * Per-section paginator. Lives INSIDE the section's Card (not as a
 * sibling card) so it's visually scoped to the list it controls —
 * eliminates the old single-paginator ambiguity where a "Next" click
 * paged BOTH lists at once. Hides itself when there's only one page.
 */
function SectionPaginationControls({
  currentPage,
  totalItems,
  totalPages,
  sliceStart,
  sliceEnd,
  itemLabel,
  onPageChange,
}: {
  currentPage: number
  totalItems: number
  totalPages: number
  sliceStart: number
  sliceEnd: number
  itemLabel: string
  onPageChange: (page: number) => void
}) {
  if (totalPages <= 1) return null

  return (
    <div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="text-xs text-muted-foreground">
        Showing{" "}
        <span className="font-semibold text-foreground">
          {sliceStart + 1}–{sliceEnd}
        </span>{" "}
        of{" "}
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
        <span className="text-xs font-medium text-foreground">
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
