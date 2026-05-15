"use client"

import { useMemo, useState } from "react"
import type { Route } from "next"
import Link from "next/link"
import { AlertTriangle, ChevronRight, CircleCheck, Search } from "lucide-react"

import { EditAdjustmentDialog } from "@/components/admin/edit-adjustment-dialog"
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

type RunEmployeeRow = PayrollEmployeeRow & {
  ready: boolean
  /// Per-run adjustment summary — only present on the "ready" rows
  /// once the admin has saved any OT hours or one-off line items for
  /// this run via the EditAdjustmentDialog. Null otherwise.
  adjustment?: {
    otNormalHours: number
    otRestHours: number
    otPublicHours: number
    allowanceCount: number
    deductionCount: number
    overrideCount: number
    hasNote: boolean
  } | null
}

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
  // Show extra OT / adjustment columns ONLY on the ready table —
  // those drive Run payroll. The setup table is purely about
  // diagnosing missing profile fields, so adjustment data is
  // irrelevant there.
  const showAdjustmentCols = mode === "ready"
  const colSpan = showAdjustmentCols ? 7 : 6

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
            {showAdjustmentCols ? <TableHead>Adjustments</TableHead> : null}
            <TableHead className="text-right"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {employees.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={colSpan}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                {emptyText}
              </TableCell>
            </TableRow>
          ) : (
            employees.map((employee) => {
              // The right-hand action depends on the row's mode:
              //
              //   • "ready"  — employee is fully onboarded for
              //                payroll, the admin just needs to set
              //                OT hours / one-off allowances before
              //                clicking Run payroll. Open the
              //                EditAdjustmentDialog modal (same UX
              //                as after generation). The PayrollRun
              //                adjustment row may not exist yet; the
              //                modal handles the null case.
              //
              //   • "setup"  — the employee's payroll profile is
              //                incomplete (missing nationality / id
              //                number / etc.) so they're NOT
              //                included on this run. Link to the
              //                employee profile so the admin can
              //                fix the missing fields. Append a
              //                `?from=` so the profile page's Back
              //                button returns the admin to this
              //                payroll run instead of the generic
              //                employees list.
              const profileHref = (
                runId
                  ? `/admin/payroll/employees/${employee.userId}?from=${encodeURIComponent(
                      `/admin/payroll/runs/${runId}`,
                    )}`
                  : `/admin/payroll/employees/${employee.userId}`
              ) as Route

              return (
                <TableRow key={employee.userId}>
                  <TableCell>
                    {mode === "ready" ? (
                      <span className="font-bold text-foreground">
                        {employee.name}
                      </span>
                    ) : (
                      <Link
                        href={profileHref}
                        className="font-bold text-foreground transition hover:text-primary"
                      >
                        {employee.name}
                      </Link>
                    )}
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
                  {showAdjustmentCols ? (
                    <TableCell>
                      <AdjustmentSummaryCell
                        adjustment={employee.adjustment ?? null}
                      />
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right">
                    {mode === "ready" && runId ? (
                      <EditAdjustmentDialog
                        runId={runId}
                        employeeProfileId={employee.employeeProfileId}
                        employeeName={employee.name}
                        employeeCode={employee.employeeId}
                        readOnly={false}
                      />
                    ) : (
                      <Button
                        asChild
                        variant="ghost"
                        size="sm"
                        className="rounded-full"
                      >
                        <Link href={profileHref}>
                          Open
                          <ChevronRight className="ml-1 h-4 w-4" />
                        </Link>
                      </Button>
                    )}
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

/**
 * Inline summary of what the admin has saved via the
 * EditAdjustmentDialog for a single ready employee. Shows OT hours
 * + one-off line item counts so an admin can scan the ready list
 * and tell at a glance who's been adjusted. Empty state reads
 * "None yet" to remind the admin that defaults (no OT / no extras)
 * will apply when they click Run payroll.
 */
function AdjustmentSummaryCell({
  adjustment,
}: {
  adjustment: RunEmployeeRow["adjustment"]
}) {
  if (!adjustment) {
    return (
      <span className="text-[11px] italic text-muted-foreground/70">
        None yet
      </span>
    )
  }

  const totalOt =
    adjustment.otNormalHours +
    adjustment.otRestHours +
    adjustment.otPublicHours

  const chips: React.ReactNode[] = []
  if (totalOt > 0) {
    // Display the breakdown only when needed (avoid noisy chips
    // when admin set just normal-day OT).
    const parts: string[] = []
    if (adjustment.otNormalHours > 0)
      parts.push(`${adjustment.otNormalHours}h N`)
    if (adjustment.otRestHours > 0)
      parts.push(`${adjustment.otRestHours}h R`)
    if (adjustment.otPublicHours > 0)
      parts.push(`${adjustment.otPublicHours}h PH`)
    chips.push(
      <Badge
        key="ot"
        variant="outline"
        className="border-sky-300/60 text-[10px] text-sky-700"
      >
        OT {parts.join(" + ")}
      </Badge>,
    )
  }
  if (adjustment.allowanceCount > 0) {
    chips.push(
      <Badge
        key="allow"
        variant="outline"
        className="border-emerald-300/60 text-[10px] text-emerald-700"
      >
        +{adjustment.allowanceCount} allowance
        {adjustment.allowanceCount === 1 ? "" : "s"}
      </Badge>,
    )
  }
  if (adjustment.deductionCount > 0) {
    chips.push(
      <Badge
        key="ded"
        variant="outline"
        className="border-rose-300/60 text-[10px] text-rose-700"
      >
        −{adjustment.deductionCount} deduction
        {adjustment.deductionCount === 1 ? "" : "s"}
      </Badge>,
    )
  }
  if (adjustment.overrideCount > 0) {
    chips.push(
      <Badge
        key="override"
        variant="outline"
        className="border-amber-300/60 text-[10px] text-amber-700"
      >
        {adjustment.overrideCount} override
        {adjustment.overrideCount === 1 ? "" : "s"}
      </Badge>,
    )
  }
  if (adjustment.hasNote) {
    chips.push(
      <Badge
        key="note"
        variant="outline"
        className="border-border/60 text-[10px] text-muted-foreground"
      >
        Note
      </Badge>,
    )
  }

  if (chips.length === 0) {
    // The adjustment row exists (e.g. notes-only) but nothing
    // material was set. Treat as no adjustments.
    return (
      <span className="text-[11px] italic text-muted-foreground/70">
        None yet
      </span>
    )
  }

  return <div className="flex flex-wrap items-center gap-1.5">{chips}</div>
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
