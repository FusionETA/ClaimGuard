"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import type { Route } from "next"
import { ChevronRight, FileText, Search, Sliders } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { formatCurrency as formatMyr } from "@/lib/utils"
import type { PayslipRow } from "@/modules/payroll/domain/runs"

/**
 * Searchable, paginated list of payslips for a payroll run.
 *
 * Identical visual treatment to the previous static list — just adds
 * a search input at the top (matches employee name / code / position)
 * and a 10-per-page pagination control at the bottom. Client-only
 * because the filter + page state live in the URL bar implicitly via
 * React state; the server passes the full payslip array in one shot.
 */
const PAGE_SIZE = 10

export function PayslipsListPanel({
  runId,
  payslips,
  showAdjustLink,
}: {
  runId: string
  payslips: PayslipRow[]
  showAdjustLink: boolean
}) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return payslips
    return payslips.filter((p) => {
      const haystack = [
        p.snapshotName,
        p.snapshotEmployeeId,
        p.snapshotPosition ?? "",
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [payslips, query])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  // Clamp current page if the filter shrank the result set.
  const currentPage = Math.min(page, totalPages)
  const pageStart = (currentPage - 1) * PAGE_SIZE
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" />
          Payslips
        </CardTitle>
        <CardDescription>
          {payslips.length} payslip{payslips.length === 1 ? "" : "s"} on
          file. Click any row to view the breakdown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
            placeholder="Search by employee name, ID, or position"
            className="pl-9"
          />
        </div>

        {pageRows.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            {query.trim().length > 0
              ? "No payslips match your search."
              : "No payslips on file yet."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {pageRows.map((p) => (
              <PayslipLink
                key={p.id}
                runId={runId}
                payslip={p}
                showAdjustLink={showAdjustLink}
              />
            ))}
          </div>
        )}

        {totalPages > 1 ? (
          <div className="flex flex-col gap-3 rounded-3xl border border-border/70 bg-background/80 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              Showing{" "}
              <span className="font-semibold text-foreground">
                {pageRows.length}
              </span>{" "}
              of{" "}
              <span className="font-semibold text-foreground">
                {filtered.length}
              </span>{" "}
              {filtered.length === payslips.length
                ? "payslips"
                : `payslips matching “${query.trim()}”`}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-full"
                disabled={currentPage === 1}
                onClick={() => setPage(currentPage - 1)}
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
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function PayslipLink({
  runId,
  payslip,
  showAdjustLink,
}: {
  runId: string
  payslip: PayslipRow
  showAdjustLink: boolean
}) {
  return (
    <div className="flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-3 py-2 text-sm transition hover:border-primary/40 hover:bg-primary/5">
      <Link
        href={`/admin/payroll/runs/${runId}/payslips/${payslip.id}` as Route}
        className="flex min-w-0 flex-1 items-center justify-between gap-3"
      >
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-foreground">
            {payslip.snapshotName}
            <span className="ml-2 text-xs text-muted-foreground">
              {payslip.snapshotEmployeeId}
            </span>
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {payslip.snapshotPosition ?? "—"} · Gross{" "}
            {formatMyr(payslip.grossPay)} · Net {formatMyr(payslip.netPay)}
          </span>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </Link>
      {showAdjustLink && (
        <Link
          href={
            `/admin/payroll/runs/${runId}/employees/${payslip.employeeProfileId}` as Route
          }
          title="Edit OT / adjustments"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border/70 px-2 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
        >
          <Sliders className="h-3 w-3" />
          Adjust
        </Link>
      )}
    </div>
  )
}
