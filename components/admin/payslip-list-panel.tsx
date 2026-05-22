"use client"

import { useMemo, useState } from "react"
import { FileText, Search } from "lucide-react"

import { EditAdjustmentDialog } from "@/components/admin/edit-adjustment-dialog"
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
import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"
import type { PayslipRow } from "@/modules/payroll/domain/runs"

function isNonCashLineItem(category: string | null | undefined): boolean {
  if (!category) return false
  const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[category as PayrollAdjustmentCategory]
  return Boolean(meta?.nonCash)
}

/**
 * Compact RM formatter. Drops the "RM " prefix (column headers
 * already imply currency) and shows "—" for zero so the table feels
 * less noisy. Negative values render with a leading minus sign so
 * negative line items (unpaid leave deductions, recoveries, etc.)
 * are obvious in the employee column breakdown.
 */
function fmt(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "—"
  return value.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** Signed formatter for line items — keeps the + or − sign. */
function fmtSigned(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "0.00"
  const sign = value < 0 ? "− " : "+ "
  return (
    sign +
    Math.abs(value).toLocaleString("en-MY", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  )
}

/** Format hour counts — renders 0 as "0" (the OT/HRS columns show 0,
 * not "—", so an admin can tell "no OT" from "no data"). */
function fmtHoursValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return value.toLocaleString("en-MY", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
}

/** HRS column: worked hours as a percentage of expected (standard)
 * hours for staff with an expected basis; the worked hours for hourly
 * staff. "—" only when neither is recorded. */
function fmtWorkingHours(payslip: {
  workedHours: number | null
  expectedHours: number | null
}): string {
  // Coerce defensively — the value may arrive as a number, a string, or
  // a Decimal-like through serialization.
  const expected = payslip.expectedHours == null ? null : Number(payslip.expectedHours)
  const worked = payslip.workedHours == null ? null : Number(payslip.workedHours)
  if (expected != null && Number.isFinite(expected) && expected > 0) {
    const pct = ((worked ?? 0) / expected) * 100
    return (
      pct.toLocaleString("en-MY", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }) + "%"
    )
  }
  if (worked != null && Number.isFinite(worked) && worked > 0) {
    return fmtHoursValue(worked)
  }
  return "—"
}

const PAGE_SIZE = 20

/**
 * Searchable, paginated payroll-run table.
 *
 * Layout follows the printable Payroll Summary PDF:
 *   - Leftmost column: Employee name + breakdown of base salary,
 *     allowances (green), deductions (red), and any OT pay line.
 *   - Hours group: Hrs (worked, for hourly), OT N/R/PH.
 *   - GROSS: prominent total for the employee this run.
 *   - Employee contributions group (cyan tint): PCB, EPF, SOCSO, EIS.
 *   - NET: take-home pay.
 *   - Employer contributions group (orange tint): EPF, SOCSO, EIS, HRDF.
 *   - COST: total cost to employer.
 *
 * Column totals across the filtered set are rendered under each
 * column heading so the admin can see run-level statutory totals at
 * a glance — matches the PDF's column-total convention.
 *
 * The whole table is wrapped in a `grid-cols-[minmax(0,1fr)]`
 * containment trick so a tall min-width on the table scrolls *inside*
 * the card, never spilling out to scroll the window.
 */
export function PayslipsListPanel({
  runId,
  payslips,
  showAdjustLink,
  runIsDraft,
}: {
  runId: string
  payslips: PayslipRow[]
  /// Whether to surface the per-row Adjust action. When the run is
  /// SUBMITTED the action still opens but renders the form read-only.
  showAdjustLink: boolean
  /// True when the run is still DRAFT. Drives the dialog's read-only
  /// flag.
  runIsDraft: boolean
}) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)

  // The standalone "Download payroll summary PDF" button moved into the
  // run-level "Download files" modal alongside the 6 other generated
  // files (and the bank disbursement CSV). The legacy
  // `/admin/payroll/runs/${runId}/summary` route still works for
  // anyone with the bookmarked URL.

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

  // Column totals across the current FILTERED set — what the admin
  // sees in the table at this moment. Mirrors the PDF's header-total
  // convention and the summary footer below.
  const totals = useMemo(() => {
    const init = {
      gross: 0,
      bik: 0,
      pcb: 0,
      epfEmp: 0,
      socsoEmp: 0,
      eisEmp: 0,
      net: 0,
      epfEr: 0,
      socsoEr: 0,
      eisEr: 0,
      hrdf: 0,
      cost: 0,
      zakat: 0,
      hrdfWage: 0,
      hrdfCount: 0,
    }
    for (const p of filtered) {
      init.gross += p.grossPay
      init.bik += p.totalBenefitsInKind
      init.pcb += p.pcb
      init.epfEmp += p.epfEmployee
      init.socsoEmp += p.socsoEmployee
      init.eisEmp += p.eisEmployee
      init.net += p.netPay
      init.epfEr += p.epfEmployer
      init.socsoEr += p.socsoEmployer
      init.eisEr += p.eisEmployer
      init.hrdf += p.hrdf
      init.cost += p.totalCostToEmployer
      init.zakat += p.zakat
      init.hrdfWage += p.hrdfWage
      if (p.hrdf > 0) init.hrdfCount += 1
    }
    return init
  }, [filtered])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageStart = (currentPage - 1) * PAGE_SIZE
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE)

  return (
    <Card data-payroll-summary-card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" />
          Payslips
        </CardTitle>
        <CardDescription>
          {payslips.length} payslip{payslips.length === 1 ? "" : "s"} on
          file. Column totals shown in the header reflect the current
          search filter.{" "}
          {/* The old per-card "Download payroll summary PDF" button moved
              into the run-level "Download files" modal (shows once the
              run is SUBMITTED). All 7 generated files + the bank CSV
              live there now — one entry point. */}
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
          // Card-internal horizontal scroll. The PDF version is
          // generated separately at /admin/payroll/runs/[id]/summary
          // via @react-pdf/renderer, so the on-screen table can be
          // as wide as it needs to be without worrying about print
          // fidelity.
          // `grid-cols-[minmax(0,1fr)]` caps the track at the available
          // width (min 0), so the 1500px-wide table can't push the card
          // past the viewport — it's constrained and scrolls instead.
          <div className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-2xl border border-border/60">
            {/* Single bounded scroll box: the Table's own wrapper is the
                only scroller. Capping its height (max-h) keeps the
                horizontal scrollbar pinned at the bottom of the visible
                box, so it's always on screen rather than at the bottom of
                a tall table that's scrolled out of view. */}
            <Table
              wrapperClassName="nice-scrollbar max-h-[70vh]"
              className={cn(
                "min-w-[1500px] text-[11px] [&_td]:px-2 [&_td]:py-2 [&_td]:whitespace-nowrap [&_td]:align-top [&_th]:px-2 [&_th]:py-2 [&_th]:whitespace-nowrap",
              )}
            >
                <TableHeader>
                  {/* ── Top header row: group labels with coloured
                       underlines, matching the PDF's "Employee
                       contributions" / "Employer contributions"
                       banded headings. */}
                  <TableRow className="border-b-0 hover:bg-transparent">
                    <TableHead className="sticky left-0 z-20 bg-background" colSpan={1}></TableHead>
                    <TableHead
                      colSpan={4}
                      className="text-center text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70"
                    >
                      Hours
                    </TableHead>
                    <TableHead className="bg-background"></TableHead>
                    <TableHead
                      colSpan={4}
                      className="border-b-2 border-cyan-300 bg-cyan-50/40 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:bg-cyan-950/20"
                    >
                      Employee contributions
                    </TableHead>
                    <TableHead className="bg-background"></TableHead>
                    <TableHead
                      colSpan={4}
                      className="border-b-2 border-orange-300 bg-orange-50/40 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-700 dark:bg-orange-950/20"
                    >
                      Employer contributions
                    </TableHead>
                    <TableHead className="bg-background"></TableHead>
                    {showAdjustLink ? (
                      <TableHead className="bg-background"></TableHead>
                    ) : null}
                  </TableRow>
                  {/* ── Column heading + total row. The total under
                       each money column matches the PDF style. */}
                  <TableRow>
                    <TableHead className="sticky left-0 z-20 bg-background border-r border-border/60">
                      Employee
                    </TableHead>
                    <TableHead className="text-right" title="Worked hours (hourly employees)">
                      Hrs
                    </TableHead>
                    <TableHead className="text-right" title="Normal-day OT hours">
                      OT&nbsp;N
                    </TableHead>
                    <TableHead className="text-right" title="Rest-day OT hours">
                      OT&nbsp;R
                    </TableHead>
                    <TableHead className="text-right" title="Public-holiday OT hours">
                      OT&nbsp;PH
                    </TableHead>
                    <TotalHead label="GROSS" total={totals.gross} />
                    <TotalHead label="PCB" total={totals.pcb} tint="emp" />
                    <TotalHead label="EPF" total={totals.epfEmp} tint="emp" />
                    <TotalHead label="SOCSO" total={totals.socsoEmp} tint="emp" />
                    <TotalHead label="EIS" total={totals.eisEmp} tint="emp" />
                    <TotalHead label="NET" total={totals.net} bold />
                    <TotalHead label="EPF" total={totals.epfEr} tint="er" />
                    <TotalHead label="SOCSO" total={totals.socsoEr} tint="er" />
                    <TotalHead label="EIS" total={totals.eisEr} tint="er" />
                    <TotalHead label="HRDF" total={totals.hrdf} tint="er" />
                    <TotalHead label="COST" total={totals.cost} bold />
                    {showAdjustLink ? (
                      <TableHead className="text-right">
                        ·
                      </TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((p) => (
                    <PayslipRow
                      key={p.id}
                      runId={runId}
                      payslip={p}
                      showAdjustLink={showAdjustLink}
                      runIsDraft={runIsDraft}
                    />
                  ))}
                </TableBody>
            </Table>
          </div>
        )}

        {/* ── Summary footer (mirrors the PDF totals block). */}
        {filtered.length > 0 ? (
          <div className="grid gap-x-8 gap-y-2 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-[12px] sm:grid-cols-2 md:grid-cols-3">
            <SummaryRow label="Number of employees" value={filtered.length} />
            <SummaryRow
              label="Total employee net pay"
              value={fmt(totals.net)}
              mono
            />
            <SummaryRow label="Total PCB payment" value={fmt(totals.pcb)} mono />
            <SummaryRow
              label="Employees subject to HRDF"
              value={totals.hrdfCount}
            />
            <SummaryRow
              label="Total wages subject to HRDF"
              value={fmt(totals.hrdfWage)}
              mono
            />
            <SummaryRow
              label="Total EPF payment"
              value={fmt(totals.epfEmp + totals.epfEr)}
              mono
            />
            <SummaryRow
              label="Total SOCSO payment"
              value={fmt(totals.socsoEmp + totals.socsoEr)}
              mono
            />
            <SummaryRow
              label="Total EIS payment"
              value={fmt(totals.eisEmp + totals.eisEr)}
              mono
            />
            <SummaryRow
              label="Total HRDF payment"
              value={fmt(totals.hrdf)}
              mono
            />
            <SummaryRow
              label="Total Zakat payment"
              value={fmt(totals.zakat)}
              mono
            />
            {totals.bik > 0 ? (
              <SummaryRow
                label="Total Benefits in Kind (non-cash, for tax)"
                value={fmt(totals.bik)}
                mono
              />
            ) : null}
          </div>
        ) : null}

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

/** Column-header cell that stacks the label on top of a running
 *  total, with optional tint matching the column group. */
function TotalHead({
  label,
  total,
  tint,
  bold,
}: {
  label: string
  total: number
  tint?: "emp" | "er"
  bold?: boolean
}) {
  return (
    <TableHead
      className={cn(
        "text-right",
        tint === "emp" && "bg-cyan-50/40 dark:bg-cyan-950/20",
        tint === "er" && "bg-orange-50/40 dark:bg-orange-950/20",
      )}
    >
      <div className="flex flex-col items-end">
        <span className={cn("text-[10px] uppercase tracking-[0.18em]", bold && "text-foreground")}>
          {label}
        </span>
        <span className="font-mono text-[11px] text-foreground">
          {fmt(total)}
        </span>
      </div>
    </TableHead>
  )
}

/** One payroll row: employee identity + line-item breakdown on the
 *  left, statutory + total amounts across the rest. */
function PayslipRow({
  runId,
  payslip,
  showAdjustLink,
  runIsDraft,
}: {
  runId: string
  payslip: PayslipRow
  showAdjustLink: boolean
  runIsDraft: boolean
}) {
  // Build the breakdown items the way the PDF does: base salary
  // first, then OT pay (computed from columns, with formula text),
  // then each line item with its sign.
  const breakdown = useMemo(() => {
    const items: Array<{ label: string; amount: number; signed: boolean }> = []
    if (payslip.proratedPay > 0) {
      items.push({
        label: "Base salary",
        amount: payslip.proratedPay,
        signed: false,
      })
    }
    if (payslip.otPay > 0) {
      const parts: string[] = []
      if (payslip.otNormalHours > 0)
        parts.push(`${payslip.otNormalHours} normal`)
      if (payslip.otRestHours > 0) parts.push(`${payslip.otRestHours} rest`)
      if (payslip.otPublicHours > 0)
        parts.push(`${payslip.otPublicHours} PH`)
      const tail = parts.length ? ` (${parts.join(" + ")})` : ""
      items.push({
        label: `Overtime${tail}`,
        amount: payslip.otPay,
        signed: true,
      })
    }
    for (const li of payslip.lineItems) {
      // BIK / perquisite rows are non-cash — they don't add to gross.
      // Tag them so the breakdown's visual math matches grossPay.
      const nonCash = li.kind === "ALLOWANCE" && isNonCashLineItem(li.category)
      if (nonCash) {
        items.push({
          label: `${li.label} (BIK · non-cash)`,
          amount: li.amount,
          signed: false,
        })
        continue
      }
      // Render deductions as negative, allowances + reimbursements
      // as positive — matches the PDF where unpaid-leave rows are
      // red minuses and allowances are green pluses.
      const sign = li.kind === "DEDUCTION" ? -1 : 1
      items.push({
        label: li.label,
        amount: sign * li.amount,
        signed: true,
      })
    }
    return items
  }, [payslip])

  return (
    <TableRow>
      <TableCell className="sticky left-0 z-10 bg-background border-r border-border/60">
        <div className="flex flex-col gap-1">
          <div className="flex flex-col">
            <span className="text-[12px] font-semibold text-foreground">
              {payslip.snapshotName}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {payslip.snapshotEmployeeId}
              {payslip.snapshotPosition ? ` · ${payslip.snapshotPosition}` : ""}
            </span>
          </div>
          {/* Breakdown lines — kept tight to the name; line items
              colour-coded by sign. */}
          <div className="mt-0.5 space-y-0.5 text-[10.5px] leading-tight text-muted-foreground">
            {breakdown.map((it, i) => (
              <BreakdownLine
                key={`${payslip.id}-${i}`}
                label={it.label}
                amount={it.amount}
                signed={it.signed}
              />
            ))}
          </div>
        </div>
      </TableCell>
      <TableCell className="text-right font-mono">
        {fmtWorkingHours(payslip)}
      </TableCell>
      <TableCell className="text-right font-mono">
        {fmtHoursValue(payslip.otNormalHours)}
      </TableCell>
      <TableCell className="text-right font-mono">
        {fmtHoursValue(payslip.otRestHours)}
      </TableCell>
      <TableCell className="text-right font-mono">
        {fmtHoursValue(payslip.otPublicHours)}
      </TableCell>
      <TableCell className="text-right font-mono font-semibold">
        {fmt(payslip.grossPay)}
      </TableCell>
      <TintedCell tint="emp" value={payslip.pcb} />
      <TintedCell tint="emp" value={payslip.epfEmployee} />
      <TintedCell tint="emp" value={payslip.socsoEmployee} />
      <TintedCell tint="emp" value={payslip.eisEmployee} />
      <TableCell className="text-right font-mono font-semibold">
        {fmt(payslip.netPay)}
      </TableCell>
      <TintedCell tint="er" value={payslip.epfEmployer} />
      <TintedCell tint="er" value={payslip.socsoEmployer} />
      <TintedCell tint="er" value={payslip.eisEmployer} />
      <TintedCell tint="er" value={payslip.hrdf} />
      <TableCell className="text-right font-mono font-semibold">
        {fmt(payslip.totalCostToEmployer)}
      </TableCell>
      {showAdjustLink ? (
        <TableCell className="text-right">
          <EditAdjustmentDialog
            runId={runId}
            employeeProfileId={payslip.employeeProfileId}
            employeeName={payslip.snapshotName}
            employeeCode={payslip.snapshotEmployeeId}
            readOnly={!runIsDraft}
          />
        </TableCell>
      ) : null}
    </TableRow>
  )
}

/** Tinted money cell — matches the column group's header tint so
 *  the eye can trace each band of contributions vertically. */
function TintedCell({
  tint,
  value,
}: {
  tint: "emp" | "er"
  value: number
}) {
  return (
    <TableCell
      className={cn(
        "text-right font-mono",
        tint === "emp" && "bg-cyan-50/30 dark:bg-cyan-950/15",
        tint === "er" && "bg-orange-50/30 dark:bg-orange-950/15",
      )}
    >
      {fmt(value)}
    </TableCell>
  )
}

/** One line in the employee-name cell. Renders allowance lines in
 *  green with a +, deduction lines in red with a − ; base salary
 *  is monochrome. */
function BreakdownLine({
  label,
  amount,
  signed,
}: {
  label: string
  amount: number
  signed: boolean
}) {
  const isNegative = amount < 0
  const isPositive = signed && amount > 0
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="truncate">{label}</span>
      <span
        className={cn(
          "shrink-0 font-mono tabular-nums",
          isNegative && "text-rose-600",
          isPositive && "text-emerald-700",
        )}
      >
        {signed
          ? fmtSigned(amount)
          : amount.toLocaleString("en-MY", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
      </span>
    </div>
  )
}

/** Footer-summary row. Bold label / mono value layout matches the
 *  PDF's run-totals block. */
function SummaryRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string | number
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn(mono && "font-mono")}>{value}</span>
    </div>
  )
}

