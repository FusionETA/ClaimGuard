"use client"

import { useState, useTransition } from "react"
import { AlertTriangle, Check, Loader2, X } from "lucide-react"

import { applySalaryChangeHintAction } from "@/app/(admin)/admin/payroll/runs/[id]/actions"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useToast } from "@/components/ui/toaster"
import { formatCurrency } from "@/lib/utils"
import type { SalaryChangeHint } from "@/modules/payroll/domain/salary-change-hint"

/**
 * Smart-hint banner card. Surfaces every mid-cycle salary change that
 * landed inside the current run's period, with a one-click "Apply
 * adjustment" button per row.
 *
 * UX rules:
 *   - Skip is client-side only — clicking just removes the row from
 *     this session's view. Next page load shows it again so the admin
 *     can't permanently forget a real over/under-payment.
 *   - Apply hits the server action. On success the page revalidates
 *     and the row disappears because the hint's marker is now in the
 *     adjustment line labels.
 *   - For UNKNOWN scenarios (payslip snapshot doesn't match old/new),
 *     no apply button — admin gets a description so they can resolve
 *     manually.
 *
 * Distinct from the readiness banner (which blocks Submit). This is
 * informational + actionable, not blocking.
 */
export function SalaryChangeHintsCard({
  runId,
  hints,
}: {
  runId: string
  hints: SalaryChangeHint[]
}) {
  // Client-side dismissals — wiped on page refresh on purpose.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const visible = hints.filter(
    (h) =>
      !dismissed.has(h.salaryChangeId) &&
      // MATCHED hints (effective on day 1, or already-applied) are
      // server-side-only signals — they wouldn't even have a
      // suggestedLineItem. The service still ships them so future
      // diagnostics can render them, but we hide them here.
      h.scenario !== "MATCHED" &&
      !h.alreadyApplied,
  )
  if (visible.length === 0) return null

  return (
    <Card className="border-amber-200 bg-amber-50/50 print:hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-amber-900">
          <AlertTriangle className="h-4 w-4" />
          Mid-cycle salary change{visible.length === 1 ? "" : "s"} detected
        </CardTitle>
        <CardDescription>
          {visible.length === 1
            ? "An employee on this run had a salary change inside this month. Apply the suggested proration to fix the payslip, or skip if you'd rather handle it manually."
            : `${visible.length} employees on this run had salary changes inside this month. Apply each suggestion individually, or skip ones you'd rather handle manually.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {visible.map((hint) => (
          <SalaryChangeHintRow
            key={`${hint.payslipId}:${hint.salaryChangeId}`}
            runId={runId}
            hint={hint}
            onDismiss={() =>
              setDismissed((s) => {
                const next = new Set(s)
                next.add(hint.salaryChangeId)
                return next
              })
            }
          />
        ))}
      </CardContent>
    </Card>
  )
}

function SalaryChangeHintRow({
  runId,
  hint,
  onDismiss,
}: {
  runId: string
  hint: SalaryChangeHint
  onDismiss: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [applied, setApplied] = useState(false)
  const { toast } = useToast()

  const handleApply = () => {
    startTransition(async () => {
      const result = await applySalaryChangeHintAction({
        runId,
        payslipId: hint.payslipId,
        salaryChangeId: hint.salaryChangeId,
      })
      if (result.status === "success") {
        setApplied(true)
        toast({ title: result.message, variant: "success" })
      } else {
        toast({ title: result.message, variant: "error" })
      }
    })
  }

  // Once Apply succeeded, the row collapses to a confirmation. We keep
  // it in the list (rather than removing) so admin can see what was
  // done. On the next page load, the server's `alreadyApplied` check
  // hides the hint entirely.
  if (applied) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm">
        <div className="flex items-center gap-2 text-emerald-800">
          <Check className="h-4 w-4" />
          <span>
            Adjustment applied for{" "}
            <span className="font-semibold">{hint.employeeName}</span>.
            The payslip will refresh on next page load.
          </span>
        </div>
      </div>
    )
  }

  const sign = hint.scenario === "OVERPAID" ? "−" : "+"
  const actionLabel =
    hint.scenario === "OVERPAID"
      ? "Deduct this amount"
      : hint.scenario === "UNDERPAID"
        ? "Add as arrears"
        : null

  return (
    <div className="rounded-2xl border border-amber-200 bg-card p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-semibold text-foreground">
          {hint.employeeName}
        </div>
        <div className="text-xs text-muted-foreground">
          {hint.reasonLabel} · Effective {hint.effectiveDate}
        </div>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        Salary{" "}
        <span className="font-mono">
          RM {hint.previousMonthlySalary.toFixed(2)}
        </span>{" "}
        →{" "}
        <span className="font-mono text-foreground">
          RM {hint.newMonthlySalary.toFixed(2)}
        </span>
        . This payslip used{" "}
        <span className="font-mono">
          RM {hint.payslipSnapshotMonthlySalary.toFixed(2)}
        </span>{" "}
        for the whole month.
      </p>

      {hint.scenario !== "UNKNOWN" ? (
        <div className="mt-3 rounded-xl bg-muted/40 p-3 text-xs">
          <p className="font-medium text-foreground">Suggested proration</p>
          <p className="mt-1 font-mono text-muted-foreground">
            {hint.previousMonthlySalary.toFixed(0)} ×{" "}
            {hint.daysAtOldRate}/{hint.totalDaysInPeriod} +{" "}
            {hint.newMonthlySalary.toFixed(0)} ×{" "}
            {hint.daysAtNewRate}/{hint.totalDaysInPeriod}{" "}
            ({hint.prorationRule === "TWENTY_SIX" ? "26-day" : "calendar days"})
          </p>
          <p className="mt-1.5">
            {actionLabel}:{" "}
            <span className="font-semibold text-foreground">
              {sign} {formatCurrency(hint.delta)}
            </span>
          </p>
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-dashed border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          The payslip uses a salary value (
          RM {hint.payslipSnapshotMonthlySalary.toFixed(2)}
          ) that doesn&apos;t match either the old or new salary. Resolve
          manually — re-generate the payslip OR add a custom adjustment.
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={onDismiss}
        >
          <X className="mr-1 h-3.5 w-3.5" />
          Skip
        </Button>
        {hint.scenario !== "UNKNOWN" ? (
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={handleApply}
          >
            {pending ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Applying…
              </>
            ) : (
              "Apply adjustment"
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
