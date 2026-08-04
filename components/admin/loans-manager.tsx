"use client"

import { useActionState, useEffect, useId, useMemo, useState } from "react"
import { HandCoins, Pencil, Plus, Search, X } from "lucide-react"

import {
  cancelLoanAction,
  createLoanAction,
  editLoanAction,
} from "@/app/(admin)/admin/payroll/loans/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { NativeSelect } from "@/components/admin/payroll-form-controls"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ConfirmSubmitButton } from "@/components/ui/confirm-action-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useToastOnAction } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import {
  formatLoanPeriodLabel,
  type LoanRepaymentMode,
} from "@/modules/payroll/domain/loans"
import type {
  EmployeeLoanWithProgress,
  LoanEmployeeOption,
} from "@/modules/payroll/application/services/loan.service"

function rm(n: number): string {
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Equal split of `principal` across `count` months (last absorbs the
 *  rounding remainder). Used to seed the Custom per-month editor. */
function equalSplit(principal: number, count: number): number[] {
  const c = Math.max(1, Math.trunc(count) || 1)
  const a = round2(principal / c)
  const out: number[] = []
  for (let i = 0; i < c; i++) {
    out.push(i === c - 1 ? Math.max(0, round2(principal - a * (c - 1))) : a)
  }
  return out
}

export function LoansManager(props: {
  loans: EmployeeLoanWithProgress[]
  employees: LoanEmployeeOption[]
}) {
  return (
    <div className="space-y-6">
      <LoanList loans={props.loans} employees={props.employees} />
    </div>
  )
}

function CreateLoanDialog(props: { employees: LoanEmployeeOption[] }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(
    createLoanAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  // Close the dialog once a create succeeds. `state` only changes identity
  // after a submission completes, so this fires on success — not on reopen.
  useEffect(() => {
    if (state.status === "success") setOpen(false)
  }, [state])

  const noEmployees = props.employees.length === 0
  const now = new Date()
  const [mode, setMode] = useState<LoanRepaymentMode>("FIXED")
  const [principal, setPrincipal] = useState("")
  const [installmentCount, setInstallmentCount] = useState("6")
  const [startYear, setStartYear] = useState(String(now.getFullYear()))
  const [startMonth, setStartMonth] = useState(String(now.getMonth() + 1))
  // Per-month amounts for CUSTOM mode (each month may differ). Seeded
  // from an equal split whenever the amount or month count changes;
  // editing an individual row doesn't reseed.
  const [customRows, setCustomRows] = useState<number[]>([])

  const years = useMemo(() => {
    const base = now.getFullYear()
    return [base - 1, base, base + 1, base + 2]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (mode !== "CUSTOM") return
    const p = Number(principal)
    const c = Number(installmentCount)
    setCustomRows(equalSplit(Number.isFinite(p) && p > 0 ? p : 0, c || 1))
  }, [mode, principal, installmentCount])

  const sy = Number(startYear)
  const sm = Number(startMonth)
  const principalNum = Number(principal)

  // FIXED preview line.
  const fixedPreview = useMemo(() => {
    if (mode !== "FIXED") return null
    if (!Number.isFinite(principalNum) || principalNum <= 0) return null
    const count = Math.trunc(Number(installmentCount) || 0)
    if (count <= 0) return null
    const split = equalSplit(principalNum, count)
    const endIdx = sm - 1 + (count - 1)
    return {
      installmentAmount: split[0],
      installmentCount: count,
      lastInstallment: split[count - 1],
      start: formatLoanPeriodLabel(sy, sm),
      end: formatLoanPeriodLabel(sy + Math.floor(endIdx / 12), (endIdx % 12) + 1),
    }
  }, [mode, principalNum, installmentCount, sy, sm])

  const customTotal = round2(customRows.reduce((s, n) => s + (Number(n) || 0), 0))
  const customBalanced =
    Number.isFinite(principalNum) &&
    principalNum > 0 &&
    Math.abs(customTotal - round2(principalNum)) < 0.01

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          disabled={noEmployees}
          title={
            noEmployees
              ? "Add a payroll-ready employee before creating a loan"
              : undefined
          }
        >
          <Plus className="h-4 w-4" />
          New Loan
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New loan / advance</DialogTitle>
          <DialogDescription>
            The monthly installment is deducted automatically on each payroll
            run from the start month, until the loan is repaid.
          </DialogDescription>
        </DialogHeader>
        <form
          action={action}
          className="nice-scrollbar -mr-2 max-h-[65vh] space-y-4 overflow-y-auto py-2 pl-1 pr-2"
        >
          {state.status === "error" && state.message ? (
            <div
              role="alert"
              className="rounded-xl border-2 border-destructive/60 bg-destructive/10 px-4 py-2.5 text-sm font-medium text-destructive"
            >
              {state.message}
            </div>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Employee">
              <NativeSelect name="employeeProfileId" defaultValue="">
                <option value="" disabled>
                  Select an employee…
                </option>
                {props.employees.map((e) => (
                  <option key={e.employeeProfileId} value={e.employeeProfileId}>
                    {e.name} ({e.employeeId})
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Loan amount (MYR)">
              <Input
                name="principalAmount"
                type="number"
                step="0.01"
                min="0"
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
                placeholder="e.g. 3000.00"
              />
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Repayment mode">
              <NativeSelect
                name="mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as LoanRepaymentMode)}
              >
                <option value="FIXED">Fixed — equal amount every month</option>
                <option value="CUSTOM">Custom — different amount per month</option>
              </NativeSelect>
            </Field>
            <Field label="Number of installments (months)">
              <Input
                name="installmentCount"
                type="number"
                step="1"
                min="1"
                max="120"
                value={installmentCount}
                onChange={(e) => setInstallmentCount(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="First repayment month">
              <NativeSelect
                name="startMonth"
                value={startMonth}
                onChange={(e) => setStartMonth(e.target.value)}
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={String(i + 1)}>
                    {m}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Year">
              <NativeSelect
                name="startYear"
                value={startYear}
                onChange={(e) => setStartYear(e.target.value)}
              >
                {years.map((y) => (
                  <option key={y} value={String(y)}>
                    {y}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>

          {/* CUSTOM — per-month amounts (each can differ). Submitted as
              installment{i}; the total must equal the loan amount. */}
          {mode === "CUSTOM" ? (
            <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
              <p className="text-xs font-medium text-muted-foreground">
                Amount per month
              </p>
              <div className="nice-scrollbar max-h-[40vh] space-y-1.5 overflow-y-auto px-1">
                {customRows.map((amt, i) => {
                  const raw = sm - 1 + i
                  const year = sy + Math.floor(raw / 12)
                  const month = (raw % 12) + 1
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-20 shrink-0 text-xs text-muted-foreground">
                        {formatLoanPeriodLabel(year, month)}
                      </span>
                      <Input
                        name={`installment${i}`}
                        type="number"
                        step="0.01"
                        min="0"
                        value={String(amt)}
                        onChange={(e) =>
                          setCustomRows((rs) =>
                            rs.map((v, idx) =>
                              idx === i ? Number(e.target.value) || 0 : v,
                            ),
                          )
                        }
                        className="flex-1"
                      />
                    </div>
                  )
                })}
              </div>
              <div
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2 text-sm",
                  customBalanced
                    ? "border-emerald-300/60 text-emerald-700"
                    : "border-destructive/60 text-destructive",
                )}
              >
                <span>Installments total</span>
                <span className="font-semibold">
                  {rm(customTotal)} /{" "}
                  {rm(Number.isFinite(principalNum) ? principalNum : 0)}
                </span>
              </div>
            </div>
          ) : fixedPreview ? (
            <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm">
              <span className="font-medium text-foreground">
                {fixedPreview.installmentCount}× {rm(fixedPreview.installmentAmount)}/month
              </span>{" "}
              <span className="text-muted-foreground">
                from {fixedPreview.start} to {fixedPreview.end}
                {fixedPreview.lastInstallment !== fixedPreview.installmentAmount
                  ? ` (final installment ${rm(fixedPreview.lastInstallment)})`
                  : ""}
                .
              </span>
            </div>
          ) : null}

          <Field label="Notes (optional)">
            <Input name="notes" placeholder="e.g. Approved by HR ticket #1234" />
          </Field>

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={pending || (mode === "CUSTOM" && !customBalanced)}
            >
              {pending ? "Creating…" : "Create loan"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LoanList(props: {
  loans: EmployeeLoanWithProgress[]
  employees: LoanEmployeeOption[]
}) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<
    "ALL" | "ACTIVE" | "COMPLETED" | "CANCELLED"
  >("ALL")
  // Range filter on the loan's first-repayment month. Values are "YYYY-MM"
  // (from <input type="month">) compared against each loan's own start key —
  // loans are month-based, so a month picker fits the data better than a day.
  const [fromMonth, setFromMonth] = useState("")
  const [toMonth, setToMonth] = useState("")
  const q = search.trim().toLowerCase()
  const filtered = props.loans.filter((loan) => {
    const matchesStatus =
      statusFilter === "ALL" || loan.derivedStatus === statusFilter
    const matchesSearch =
      q === "" ||
      (loan.employeeName ?? "").toLowerCase().includes(q) ||
      (loan.employeeCode ?? "").toLowerCase().includes(q)
    const loanMonth = `${loan.startYear}-${String(loan.startMonth).padStart(2, "0")}`
    const matchesFrom = fromMonth === "" || loanMonth >= fromMonth
    const matchesTo = toMonth === "" || loanMonth <= toMonth
    return matchesStatus && matchesSearch && matchesFrom && matchesTo
  })

  if (props.loans.length === 0) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <HandCoins className="h-4 w-4 text-primary" />
              Loans
            </CardTitle>
            <CardDescription>No loans recorded yet.</CardDescription>
          </div>
          <CreateLoanDialog employees={props.employees} />
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <HandCoins className="h-4 w-4 text-primary" />
            Loans ({props.loans.length})
          </CardTitle>
          <CardDescription>
            Repayment progress is derived from submitted payroll runs.
          </CardDescription>
        </div>
        <CreateLoanDialog employees={props.employees} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by employee name or ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <NativeSelect
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as typeof statusFilter)
            }
            className="w-[150px] shrink-0"
          >
            <option value="ALL">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </NativeSelect>
          {/* Start-month range filter. Clear appears once a bound is set. */}
          <div className="flex items-center gap-1.5 rounded-2xl border border-border/70 bg-card px-3 py-1.5 shadow-sm">
            <span className="text-xs font-medium text-muted-foreground">From</span>
            <input
              type="month"
              value={fromMonth}
              onChange={(e) => setFromMonth(e.target.value)}
              className="bg-transparent text-sm text-foreground outline-none"
              aria-label="Loans starting from month"
            />
            <span className="text-xs font-medium text-muted-foreground">To</span>
            <input
              type="month"
              value={toMonth}
              onChange={(e) => setToMonth(e.target.value)}
              className="bg-transparent text-sm text-foreground outline-none"
              aria-label="Loans starting up to month"
            />
            {fromMonth || toMonth ? (
              <button
                type="button"
                onClick={() => {
                  setFromMonth("")
                  setToMonth("")
                }}
                className="ml-0.5 rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Clear month range"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
        {/* `grid-cols-[minmax(0,1fr)]` caps the track at the card width
            so the wide table scrolls inside its own box instead of
            pushing the whole page wider than the window. */}
        <div className="grid grid-cols-[minmax(0,1fr)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Principal</TableHead>
              <TableHead>Installment</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Repaid</TableHead>
              <TableHead>Remaining</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  No loans match your filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((loan) => (
              <TableRow key={loan.id}>
                <TableCell>
                  <span className="font-medium text-foreground">
                    {loan.employeeName ?? "—"}
                  </span>
                  {loan.employeeCode ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      ({loan.employeeCode})
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>{rm(loan.principalAmount)}</TableCell>
                <TableCell>
                  {rm(loan.installmentAmount)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {loan.mode === "FIXED" ? "fixed" : "custom"}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatLoanPeriodLabel(loan.startYear, loan.startMonth)} →{" "}
                  {formatLoanPeriodLabel(loan.summary.endYear, loan.summary.endMonth)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({loan.installmentCount}×)
                  </span>
                </TableCell>
                <TableCell>
                  {loan.summary.paidInstallments}/{loan.summary.totalInstallments}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({rm(loan.summary.paidAmount)})
                  </span>
                </TableCell>
                <TableCell>{rm(loan.summary.remainingAmount)}</TableCell>
                <TableCell>
                  <StatusBadge status={loan.derivedStatus} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {loan.derivedStatus !== "CANCELLED" ? (
                      <EditLoanDialog loan={loan} />
                    ) : null}
                    {loan.status === "ACTIVE" && !loan.summary.fullyRepaid ? (
                      <CancelLoanButton loanId={loan.id} />
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBadge({ status }: { status: "ACTIVE" | "COMPLETED" | "CANCELLED" }) {
  const styles: Record<typeof status, string> = {
    ACTIVE: "border-emerald-300/60 text-emerald-700",
    COMPLETED: "border-sky-300/60 text-sky-700",
    CANCELLED: "border-muted-foreground/40 text-muted-foreground",
  }
  const label = status.charAt(0) + status.slice(1).toLowerCase()
  return (
    <Badge variant="outline" className={cn("text-[10px] uppercase tracking-wide", styles[status])}>
      {label}
    </Badge>
  )
}

function CancelLoanButton({ loanId }: { loanId: string }) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    cancelLoanAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)
  return (
    <form id={formId} action={action}>
      <input type="hidden" name="loanId" value={loanId} />
      <ConfirmSubmitButton
        formId={formId}
        title="Cancel this loan?"
        description="No further installments will be deducted on upcoming payroll runs. Already-deducted installments on submitted runs are unaffected."
        confirmLabel="Cancel loan"
        triggerLabel="Cancel"
        pendingLabel="Cancelling…"
        pending={pending}
        triggerVariant="ghost"
        triggerClassName="text-destructive"
        confirmVariant="destructive"
      />
    </form>
  )
}

// ─── Edit loan ──────────────────────────────────────────────────────────

type FormAction = (formData: FormData) => void

function EditLoanDialog({ loan }: { loan: EmployeeLoanWithProgress }) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(
    editLoanAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)
  // Close on a successful save.
  useEffect(() => {
    if (state.status === "success") setOpen(false)
  }, [state])

  const started = loan.summary.hasStarted
  const customEditable =
    started && loan.mode === "CUSTOM" && !loan.summary.fullyRepaid
  const fullEditable = !started
  const readOnly = !fullEditable && !customEditable

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-8 gap-1 text-xs">
          <Pencil className="h-3.5 w-3.5" />
          {readOnly ? "View" : "Edit"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-h-[88vh] sm:max-w-lg sm:overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {readOnly ? "Loan schedule" : "Edit loan"}
            {loan.employeeName ? ` — ${loan.employeeName}` : ""}
          </DialogTitle>
          <DialogDescription>
            {fullEditable
              ? "No repayment has started yet, so all terms can be changed."
              : customEditable
                ? "Repayment has started — paid installments are locked. Edit the upcoming ones; the total must still equal the loan amount."
                : "Repayment has started on a fixed-installment loan, so the schedule is locked. Here's the breakdown."}
          </DialogDescription>
        </DialogHeader>

        {state.status === "error" && state.message ? (
          <div
            role="alert"
            className="rounded-xl border-2 border-destructive/60 bg-destructive/10 px-4 py-2.5 text-sm font-medium text-destructive"
          >
            {state.message}
          </div>
        ) : null}

        {fullEditable ? (
          <FullEditLoanForm loan={loan} action={action} pending={pending} />
        ) : customEditable ? (
          <ScheduleEditLoanForm loan={loan} action={action} pending={pending} />
        ) : (
          <ReadOnlyBreakdown loan={loan} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function FullEditLoanForm(props: {
  loan: EmployeeLoanWithProgress
  action: FormAction
  pending: boolean
}) {
  const { loan } = props
  const now = new Date()
  const [mode, setMode] = useState<LoanRepaymentMode>(loan.mode)
  const [principal, setPrincipal] = useState(String(loan.principalAmount))
  const [count, setCount] = useState(String(loan.installmentCount))
  const [startYear, setStartYear] = useState(String(loan.startYear))
  const [startMonth, setStartMonth] = useState(String(loan.startMonth))
  // Seed the Custom editor from the loan's current schedule.
  const [customRows, setCustomRows] = useState<number[]>(loan.schedule)
  const years = useMemo(() => {
    const b = now.getFullYear()
    return [b - 1, b, b + 1, b + 2]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reseed the per-month rows whenever the amount or month count
  // changes (but not when editing an individual row).
  useEffect(() => {
    if (mode !== "CUSTOM") return
    const p = Number(principal)
    setCustomRows(equalSplit(Number.isFinite(p) && p > 0 ? p : 0, Number(count) || 1))
  }, [mode, principal, count])

  const sy = Number(startYear)
  const sm = Number(startMonth)
  const principalNum = Number(principal)
  const customTotal = round2(customRows.reduce((s, n) => s + (Number(n) || 0), 0))
  const customBalanced =
    Number.isFinite(principalNum) &&
    principalNum > 0 &&
    Math.abs(customTotal - round2(principalNum)) < 0.01

  return (
    <form action={props.action} className="space-y-4">
      <input type="hidden" name="loanId" value={loan.id} />
      <Field label="Loan amount (MYR)">
        <Input
          name="principalAmount"
          type="number"
          step="0.01"
          min="0"
          value={principal}
          onChange={(e) => setPrincipal(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Repayment mode">
          <NativeSelect
            name="mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as LoanRepaymentMode)}
          >
            <option value="FIXED">Fixed — equal amount every month</option>
            <option value="CUSTOM">Custom — different amount per month</option>
          </NativeSelect>
        </Field>
        <Field label="Number of installments (months)">
          <Input
            name="installmentCount"
            type="number"
            step="1"
            min="1"
            max="120"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="First repayment month">
          <NativeSelect
            name="startMonth"
            value={startMonth}
            onChange={(e) => setStartMonth(e.target.value)}
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={String(i + 1)}>
                {m}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Year">
          <NativeSelect
            name="startYear"
            value={startYear}
            onChange={(e) => setStartYear(e.target.value)}
          >
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      {mode === "CUSTOM" ? (
        <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
          <p className="text-xs font-medium text-muted-foreground">Amount per month</p>
          <div className="space-y-1.5">
            {customRows.map((amt, i) => {
              const raw = sm - 1 + i
              const year = sy + Math.floor(raw / 12)
              const month = (raw % 12) + 1
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">
                    {formatLoanPeriodLabel(year, month)}
                  </span>
                  <Input
                    name={`installment${i}`}
                    type="number"
                    step="0.01"
                    min="0"
                    value={String(amt)}
                    onChange={(e) =>
                      setCustomRows((rs) =>
                        rs.map((v, idx) =>
                          idx === i ? Number(e.target.value) || 0 : v,
                        ),
                      )
                    }
                    className="flex-1"
                  />
                </div>
              )
            })}
          </div>
          <div
            className={cn(
              "flex items-center justify-between rounded-lg border px-3 py-2 text-sm",
              customBalanced
                ? "border-emerald-300/60 text-emerald-700"
                : "border-destructive/60 text-destructive",
            )}
          >
            <span>Installments total</span>
            <span className="font-semibold">
              {rm(customTotal)} / {rm(Number.isFinite(principalNum) ? principalNum : 0)}
            </span>
          </div>
        </div>
      ) : null}
      <Field label="Notes (optional)">
        <Input name="notes" defaultValue={loan.notes ?? ""} />
      </Field>
      <DialogFooter>
        <Button
          type="submit"
          disabled={props.pending || (mode === "CUSTOM" && !customBalanced)}
        >
          {props.pending ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ScheduleEditLoanForm(props: {
  loan: EmployeeLoanWithProgress
  action: FormAction
  pending: boolean
}) {
  const { loan } = props
  const [rows, setRows] = useState(() =>
    loan.breakdown.map((b) => ({
      amount: b.amount,
      paid: b.paid,
      year: b.year,
      month: b.month,
    })),
  )

  function setAmount(i: number, v: number) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, amount: v } : r)))
  }
  function addRow() {
    setRows((rs) => {
      const idx = rs.length
      const raw = loan.startMonth - 1 + idx
      const year = loan.startYear + Math.floor(raw / 12)
      const month = (raw % 12) + 1
      return [...rs, { amount: 0, paid: false, year, month }]
    })
  }
  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, idx) => idx !== i))
  }

  const total = Math.round(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100
  const balanced = Math.abs(total - loan.principalAmount) < 0.01

  return (
    <form action={props.action} className="space-y-3">
      <input type="hidden" name="loanId" value={loan.id} />
      <div className="space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-xs text-muted-foreground">
              {formatLoanPeriodLabel(r.year, r.month)}
            </span>
            {r.paid ? (
              <>
                <Input
                  defaultValue={r.amount.toFixed(2)}
                  disabled
                  className="flex-1"
                />
                <input type="hidden" name={`installment${i}`} value={String(r.amount)} />
                <Badge
                  variant="outline"
                  className="shrink-0 border-emerald-300/60 text-[10px] uppercase text-emerald-700"
                >
                  Paid
                </Badge>
              </>
            ) : (
              <>
                <Input
                  name={`installment${i}`}
                  type="number"
                  step="0.01"
                  min="0"
                  value={String(r.amount)}
                  onChange={(e) => setAmount(i, Number(e.target.value) || 0)}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-destructive"
                  onClick={() => removeRow(i)}
                  title="Remove installment"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
      <Button type="button" variant="ghost" size="sm" className="gap-1" onClick={addRow}>
        <Plus className="h-3.5 w-3.5" />
        Add installment
      </Button>
      <div
        className={cn(
          "flex items-center justify-between rounded-lg border px-3 py-2 text-sm",
          balanced
            ? "border-emerald-300/60 text-emerald-700"
            : "border-destructive/60 text-destructive",
        )}
      >
        <span>Installments total</span>
        <span className="font-semibold">
          {rm(total)} / {rm(loan.principalAmount)}
        </span>
      </div>
      <Field label="Notes (optional)">
        <Input name="notes" defaultValue={loan.notes ?? ""} />
      </Field>
      <DialogFooter>
        <Button type="submit" disabled={props.pending || !balanced}>
          {props.pending ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ReadOnlyBreakdown({ loan }: { loan: EmployeeLoanWithProgress }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {loan.breakdown.map((b) => (
          <div
            key={b.index}
            className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
          >
            <span className="text-muted-foreground">
              {formatLoanPeriodLabel(b.year, b.month)}
            </span>
            <span className="font-medium text-foreground">{rm(b.amount)}</span>
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] uppercase tracking-wide",
                b.paid
                  ? "border-emerald-300/60 text-emerald-700"
                  : "border-muted-foreground/40 text-muted-foreground",
              )}
            >
              {b.paid ? "Paid" : "Upcoming"}
            </Badge>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Paid {loan.summary.paidInstallments}/{loan.summary.totalInstallments} ·
        Remaining {rm(loan.summary.remainingAmount)}
      </p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}
