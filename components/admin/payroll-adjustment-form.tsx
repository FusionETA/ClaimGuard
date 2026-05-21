"use client"

import { useActionState, useEffect, useId, useMemo, useRef, useState } from "react"
import Link from "next/link"
import type { Route } from "next"
import { ExternalLink, HandCoins, Plus, RotateCcw, Trash2 } from "lucide-react"

import {
  clearPayrollAdjustmentAction,
  savePayrollAdjustmentAction,
} from "@/app/(admin)/admin/payroll/runs/[id]/employees/[empProfileId]/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { NativeSelect } from "@/components/admin/payroll-form-controls"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmSubmitButton } from "@/components/ui/confirm-action-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToastOnAction } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import {
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  payrollAdjustmentCategories,
  payrollAdjustmentCategoryGroups,
  type FixedAllowance,
  type PayrollAdjustmentCategory,
} from "@/modules/payroll/domain/models"
import {
  type ManualLineItem,
  type PayrollRunAdjustmentData,
} from "@/modules/payroll/domain/runs"

/**
 * Per-employee adjustment form. Stacks four cards: OT, manual line
 * items (dynamic list), unpaid-leave, and notes. Saves via
 * `savePayrollAdjustmentAction`; manual line items serialise as
 * `line[i].kind` / `line[i].label` / `line[i].amount`.
 *
 * In read-only mode (run already submitted), the form still renders
 * the values but inputs are disabled.
 */
export function PayrollAdjustmentForm(props: {
  runId: string
  employeeProfileId: string
  adjustment: PayrollRunAdjustmentData | null
  fixedAllowances: FixedAllowance[]
  /// Active loan installments auto-deducted for this run's period.
  /// Shown read-only — editing happens on the Loans page.
  loans?: Array<{ id: string; label: string; amount: number }>
  readOnly: boolean
  /// Optional — fires once after a save action lands "success".
  /// Used by the modal-dialog wrapper to close itself.
  onSaved?: () => void
  /// Optional — when the form is rendered inside a dialog, the parent
  /// provides a stable id so a Save button placed in the dialog's
  /// own footer can target this form via `form="<id>"`. If not
  /// provided, a local useId() is generated (standalone use).
  saveFormId?: string
  /// Optional — when true, the form does NOT render its own bottom
  /// action bar. The parent dialog owns the Save + Clear buttons in
  /// its DialogFooter instead. Default false (inline action bar).
  hideActions?: boolean
  /// Optional — fired whenever the save action's pending state flips.
  /// Lets the dialog's external Save button show "Saving…" without
  /// reaching back into the form's internal hook.
  onPendingChange?: (pending: boolean) => void
}) {
  // Use the parent-provided id when one is passed (modal mode), else
  // generate a local one for standalone use. Either way both the
  // Save button (which may live OUTSIDE the form, in a sibling
  // DialogFooter) and the form element share the id via the HTML5
  // `form="<id>"` attribute.
  const localSaveFormId = useId()
  const saveFormId = props.saveFormId ?? localSaveFormId

  const [state, action, pending] = useActionState(
    savePayrollAdjustmentAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  // Report pending state up so an externally-rendered Save button
  // (in the dialog footer) can disable itself / show a spinner.
  useEffect(() => {
    props.onPendingChange?.(pending)
    // We deliberately don't depend on the callback ref — re-firing on
    // every render would defeat the purpose of memoising it upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  // Fire `onSaved` exactly once per save-success. We track the last
  // state ref the callback fired for so a re-render with the same
  // success state (toast still on screen) doesn't repeat.
  const lastSavedSignal = useRef<string | null>(null)
  useEffect(() => {
    if (state.status === "success" && props.onSaved) {
      const signal = `${state.status}:${state.message}`
      if (lastSavedSignal.current !== signal) {
        lastSavedSignal.current = signal
        props.onSaved()
      }
    }
    // Depend on the state reference, not just primitives — see
    // useToastOnAction in components/ui/toaster.tsx for the rationale.
    // The lastSavedSignal ref handles the "fired-already-for-this-result"
    // de-dupe so depending on the reference doesn't double-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const [lines, setLines] = useState<ManualLineItem[]>(
    props.adjustment?.manualLineItems ?? [],
  )

  // Hydrate the override state from the saved JSON column. Each row in
  // the UI starts at the profile amount, and we apply any stored
  // override on top. The form serialises three fields per row back —
  // `override{i}.amount`, `override{i}.skip`, `override{i}.original` —
  // and the action only persists rows that actually deviate.
  const initialOverrides = useMemo(
    () =>
      props.fixedAllowances.map((fa, i) => {
        const o = props.adjustment?.fixedAllowanceOverrides?.[String(i)]
        return {
          amount:
            o?.amount != null ? o.amount : fa.amount,
          skip: o?.skip === true,
        }
      }),
    [props.fixedAllowances, props.adjustment?.fixedAllowanceOverrides],
  )
  const [overrides, setOverrides] = useState(initialOverrides)
  function patchOverride(i: number, patch: Partial<{ amount: number; skip: boolean }>) {
    setOverrides((rs) =>
      rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    )
  }
  function resetOverride(i: number) {
    const fa = props.fixedAllowances[i]
    if (!fa) return
    setOverrides((rs) =>
      rs.map((r, idx) => (idx === i ? { amount: fa.amount, skip: false } : r)),
    )
  }

  function addLine(kind: "ALLOWANCE" | "DEDUCTION") {
    // Default category by kind. Admin can pick a more specific one
    // from the dropdown (e.g. annual bonus, travel allowance, advance
    // recovery, CP38) — those carry their own statutory treatment.
    const category =
      kind === "DEDUCTION" ? "deduct_salary_adjustment" : "allowance_standard"
    const label = PAYROLL_ADJUSTMENT_CATEGORY_META[category].label
    setLines((cs) => [...cs, { kind, category, label, amount: 0 }])
  }
  function removeLine(i: number) {
    setLines((cs) => cs.filter((_, idx) => idx !== i))
  }
  function patchLine(i: number, patch: Partial<ManualLineItem>) {
    setLines((cs) =>
      cs.map((entry, idx) => (idx === i ? { ...entry, ...patch } : entry)),
    )
  }

  const allowanceCount = lines.filter((l) => l.kind === "ALLOWANCE").length
  const deductionCount = lines.filter((l) => l.kind === "DEDUCTION").length

  return (
    <div className="space-y-6">
    <form id={saveFormId} action={action} className="space-y-6">
      <input type="hidden" name="runId" value={props.runId} hidden />
      <input
        type="hidden"
        name="employeeProfileId"
        value={props.employeeProfileId}
        hidden
      />

      {/* Validation banner — highlighted in red when a save is blocked
          (e.g. deductions would push net pay to zero or below). The
          dialog stays open on error so the admin can fix the amounts. */}
      {state.status === "error" && state.message ? (
        <div
          role="alert"
          className="rounded-xl border-2 border-destructive/60 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
        >
          {state.message}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Overtime hours</CardTitle>
          <CardDescription>
            Hours worked beyond the regular schedule. The org&apos;s OT
            multipliers (Settings → General) turn these into RM at calc
            time.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <Field label="Normal day OT (hours)">
            <Input
              name="otNormalHours"
              type="number"
              step="0.01"
              min="0"
              max="744"
              defaultValue={props.adjustment?.otNormalHours ?? 0}
              disabled={props.readOnly}
            />
          </Field>
          <Field label="Rest day OT (hours)">
            <Input
              name="otRestHours"
              type="number"
              step="0.01"
              min="0"
              max="744"
              defaultValue={props.adjustment?.otRestHours ?? 0}
              disabled={props.readOnly}
            />
          </Field>
          <Field label="Public holiday OT (hours)">
            <Input
              name="otPublicHours"
              type="number"
              step="0.01"
              min="0"
              max="744"
              defaultValue={props.adjustment?.otPublicHours ?? 0}
              disabled={props.readOnly}
            />
          </Field>
        </CardContent>
      </Card>

      {props.fixedAllowances.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Fixed adjustments this run
            </CardTitle>
            <CardDescription>
              Recurring adjustments from this employee&apos;s payroll
              profile. Edit the amount or skip a row to override it for
              this run only — the underlying profile is not touched.
              Statutory treatment (EPF / SOCSO / EIS / PCB) follows the
              original category.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {props.fixedAllowances.map((fa, i) => {
              const meta =
                PAYROLL_ADJUSTMENT_CATEGORY_META[fa.category] ??
                PAYROLL_ADJUSTMENT_CATEGORY_META.allowance_standard
              const override = overrides[i] ?? { amount: fa.amount, skip: false }
              const isAmountOverride =
                !override.skip &&
                Math.abs(override.amount - fa.amount) > 0.0001
              const isOverridden = override.skip || isAmountOverride
              const statutory = [
                meta.subjectToEpf ? "EPF" : null,
                meta.subjectToSocso ? "SOCSO" : null,
                meta.subjectToEis ? "EIS" : null,
                meta.subjectToPcb ? "PCB" : null,
              ].filter(Boolean)
              return (
                <div
                  key={i}
                  className="rounded-lg border border-border/60 bg-muted/30 p-3"
                >
                  {/* Hidden inputs — the action reads these three keys
                      per row and rebuilds the override map. `original`
                      lets the server distinguish a real override from
                      typing the same number back in. */}
                  <input
                    type="hidden"
                    name={`override${i}.original`}
                    value={String(fa.amount)}
                  />
                  <input
                    type="hidden"
                    name={`override${i}.skip`}
                    value={override.skip ? "true" : "false"}
                  />
                  <div className="grid items-end gap-3 md:grid-cols-[1.4fr_180px_auto]">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {fa.name}
                        </span>
                        {isOverridden && (
                          <Badge
                            variant="outline"
                            className="border-amber-300/60 text-[10px] uppercase tracking-wide text-amber-700"
                          >
                            {override.skip ? "Skipped" : "Overridden"}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {meta.label} ·{" "}
                        {meta.kind === "DEDUCTION"
                          ? meta.reducesBase
                            ? "Deduction - reduces base"
                            : "Deduction"
                          : meta.kind === "REIMBURSEMENT"
                            ? "Reimbursement"
                            : "Earning"}
                        {" · "}
                        Statutory:{" "}
                        {statutory.length > 0 ? statutory.join(", ") : "none"}
                        {" · "}
                        Profile baseline: RM
                        {fa.amount.toLocaleString("en-MY", {
                          minimumFractionDigits: 2,
                        })}
                      </p>
                    </div>
                    <Field label="Amount this run (MYR)">
                      <Input
                        name={`override${i}.amount`}
                        type="number"
                        step="0.01"
                        min="0"
                        value={String(override.amount)}
                        onChange={(e) =>
                          patchOverride(i, {
                            amount: Number(e.target.value) || 0,
                          })
                        }
                        disabled={props.readOnly || override.skip}
                      />
                    </Field>
                    {!props.readOnly && (
                      <div className="flex flex-col items-end gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant={override.skip ? "default" : "ghost"}
                          onClick={() =>
                            patchOverride(i, { skip: !override.skip })
                          }
                          title={
                            override.skip
                              ? "Bring this allowance back for this run"
                              : "Skip this allowance for this run only"
                          }
                          className={cn(
                            "text-xs",
                            !override.skip && "text-muted-foreground",
                          )}
                        >
                          {override.skip ? "Restore" : "Skip this run"}
                        </Button>
                        {isOverridden && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => resetOverride(i)}
                            className="h-auto px-1 py-0.5 text-[11px] text-muted-foreground"
                            title="Reset to profile baseline"
                          >
                            <RotateCcw className="mr-1 h-3 w-3" />
                            Reset to profile
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            <p className="text-[11px] text-muted-foreground">
              Changes here apply only to this payroll run. To change the
              recurring amount, edit the employee&apos;s Fixed
              adjustments on the Employment tab.
            </p>
          </CardContent>
        </Card>
      )}

      {props.loans && props.loans.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HandCoins className="h-4 w-4 text-primary" />
              Loan repayments
            </CardTitle>
            <CardDescription>
              Auto-deducted this month from an active loan. To change the
              amount or schedule, manage it on the Loans page — it can&apos;t
              be edited here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {props.loans.map((loan) => (
              <div
                key={loan.id}
                className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm"
              >
                <span className="text-foreground">{loan.label}</span>
                <span className="font-medium text-destructive">
                  − RM
                  {loan.amount.toLocaleString("en-MY", {
                    minimumFractionDigits: 2,
                  })}
                </span>
              </div>
            ))}
            <Link
              href={"/admin/payroll/loans" as Route}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Manage loans
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
          <div>
            <CardTitle className="text-base">One-off line items</CardTitle>
            <CardDescription>
              Allowances and deductions that apply to this run only.
              Recurring allowances live on the employee&apos;s payroll
              profile.
            </CardDescription>
          </div>
          {!props.readOnly && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => addLine("ALLOWANCE")}
              >
                <Plus className="h-3.5 w-3.5" />
                Allowance
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => addLine("DEDUCTION")}
              >
                <Plus className="h-3.5 w-3.5" />
                Deduction
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {lines.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No one-off line items.{" "}
              {props.readOnly
                ? ""
                : "Click Allowance or Deduction to add one."}
            </p>
          ) : (
            <>
              {allowanceCount > 0 && (
                <div className="text-xs font-medium text-muted-foreground">
                  Allowances ({allowanceCount})
                </div>
              )}
              {lines.map((line, i) => {
                if (line.kind !== "ALLOWANCE") return null
                return (
                  <LineRow
                    key={`a-${i}`}
                    index={i}
                    line={line}
                    onChange={(p) => patchLine(i, p)}
                    onRemove={() => removeLine(i)}
                    readOnly={props.readOnly}
                  />
                )
              })}
              {deductionCount > 0 && (
                <div className="mt-3 text-xs font-medium text-muted-foreground">
                  Deductions ({deductionCount})
                </div>
              )}
              {lines.map((line, i) => {
                if (line.kind !== "DEDUCTION") return null
                return (
                  <LineRow
                    key={`d-${i}`}
                    index={i}
                    line={line}
                    onChange={(p) => patchLine(i, p)}
                    onRemove={() => removeLine(i)}
                    readOnly={props.readOnly}
                  />
                )
              })}
            </>
          )}
        </CardContent>
      </Card>

      {/* Unpaid leave is entered via the "Add deduction" picker using
          the `deduct_unpaid_leave` category — it flows through the
          line-item path and reduces EPF/SOCSO/EIS/PCB/HRDF wage bases
          via `reducesBase: true`. */}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
          <CardDescription>
            Optional notes for the admin&apos;s own audit trail. Not
            shown on the employee payslip.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <textarea
            name="notes"
            defaultValue={props.adjustment?.notes ?? ""}
            rows={3}
            disabled={props.readOnly}
            placeholder="e.g. Approved by HR ticket #1234"
            className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
          />
        </CardContent>
      </Card>

    </form>
    {/* Inline action bar — only rendered when the parent doesn't
        opt into rendering its own footer (`hideActions`). In modal
        mode the EditAdjustmentDialog renders Save + Clear in a real
        DialogFooter so the buttons sit in a proper bottom strip
        outside the scrolling body. */}
    {!props.readOnly && !props.hideActions && (
      <div className="flex flex-wrap items-center justify-between gap-3">
        {props.adjustment ? (
          <ClearAdjustmentButton
            runId={props.runId}
            employeeProfileId={props.employeeProfileId}
          />
        ) : (
          <span />
        )}
        <Button type="submit" form={saveFormId} disabled={pending}>
          {pending ? "Saving…" : "Save adjustments"}
        </Button>
      </div>
    )}
    </div>
  )
}

function LineRow(props: {
  index: number
  line: ManualLineItem
  onChange: (p: Partial<ManualLineItem>) => void
  onRemove: () => void
  readOnly: boolean
}) {
  const category =
    PAYROLL_ADJUSTMENT_CATEGORY_META[
      props.line.category as PayrollAdjustmentCategory
    ] ?? PAYROLL_ADJUSTMENT_CATEGORY_META.allowance_standard
  const statutory = [
    category.subjectToEpf ? "EPF" : null,
    category.subjectToSocso ? "SOCSO" : null,
    category.subjectToEis ? "EIS" : null,
    category.subjectToPcb ? "PCB" : null,
  ].filter(Boolean)
  // Filter categories shown in the dropdown to ones that match the
  // row's intent. Admin clicked "Add allowance" → only earning-style
  // categories. Clicked "Add deduction" → only deduction categories.
  // Reimbursement categories aren't surfaced here — those flow through
  // the Reimbursements (claims) section instead.
  const allowedCategories = payrollAdjustmentCategories.filter((code) => {
    const meta = PAYROLL_ADJUSTMENT_CATEGORY_META[code]
    if (props.line.kind === "DEDUCTION") return meta.kind === "DEDUCTION"
    return meta.kind === "ALLOWANCE"
  })

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
      <input
        type="hidden"
        name={`line${props.index}.kind`}
        value={props.line.kind}
        hidden
      />
      <div className="grid items-end gap-3 md:grid-cols-[1.4fr_1fr_180px_auto]">
        <Field label="Category">
          <NativeSelect
            name={`line${props.index}.category`}
            value={props.line.category}
            onChange={(e) => {
              const next = e.target.value as PayrollAdjustmentCategory
              const nextMeta = PAYROLL_ADJUSTMENT_CATEGORY_META[next]
              props.onChange({
                category: next,
                // Auto-fill the display name with the category label,
                // but only when the admin hasn't customised it. Keeps
                // their typed labels intact across category switches.
                label:
                  props.line.label === category.label || props.line.label === ""
                    ? nextMeta.label
                    : props.line.label,
              })
            }}
            disabled={props.readOnly}
          >
            {payrollAdjustmentCategoryGroups
              .filter((group) =>
                allowedCategories.some(
                  (code) =>
                    PAYROLL_ADJUSTMENT_CATEGORY_META[code].group === group,
                ),
              )
              .map((group) => (
                <optgroup key={group} label={group}>
                  {allowedCategories
                    .filter(
                      (code) =>
                        PAYROLL_ADJUSTMENT_CATEGORY_META[code].group === group,
                    )
                    .map((code) => (
                      <option key={code} value={code}>
                        {PAYROLL_ADJUSTMENT_CATEGORY_META[code].label}
                      </option>
                    ))}
                </optgroup>
              ))}
          </NativeSelect>
        </Field>
        <Field label="Display name">
          <Input
            name={`line${props.index}.label`}
            value={props.line.label}
            onChange={(e) => props.onChange({ label: e.target.value })}
            placeholder={category.label}
            disabled={props.readOnly}
          />
        </Field>
        <Field label="Amount (MYR)">
          <Input
            name={`line${props.index}.amount`}
            type="number"
            step="0.01"
            min="0"
            value={String(props.line.amount)}
            onChange={(e) =>
              props.onChange({ amount: Number(e.target.value) || 0 })
            }
            disabled={props.readOnly}
          />
        </Field>
        {!props.readOnly && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            onClick={props.onRemove}
            title="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full bg-background px-2 py-0.5 font-medium text-foreground">
          {category.kind === "DEDUCTION"
            ? category.reducesBase
              ? "Deduction - reduces base"
              : "Deduction"
            : "Earning"}
        </span>
        <span>
          Statutory: {statutory.length > 0 ? statutory.join(", ") : "none"}
        </span>
        {category.taxExemptLimit ? (
          <span>
            Tax exempt limit: RM{category.taxExemptLimit.toLocaleString()}/year
          </span>
        ) : null}
        {category.offsetsPcb ? <span>Offsets PCB</span> : null}
      </div>
    </div>
  )
}

/**
 * Self-contained "Clear all adjustments" form + confirm button. Can
 * be rendered inside the form's own action bar (standalone use) OR
 * inside the dialog's footer (modal use) — the button targets its
 * sibling form via the `form` attribute, so the form element can
 * live anywhere in the document.
 */
export function ClearAdjustmentButton(props: {
  runId: string
  employeeProfileId: string
}) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    clearPayrollAdjustmentAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <input
        type="hidden"
        name="employeeProfileId"
        value={props.employeeProfileId}
        hidden
      />
      <ConfirmSubmitButton
        formId={formId}
        title="Clear all adjustments?"
        description="OT hours, one-off line items, and unpaid-leave deductions for this employee will all be reset to zero."
        confirmLabel="Clear adjustments"
        triggerLabel="Clear all adjustments"
        pendingLabel="Clearing..."
        pending={pending}
        triggerVariant="ghost"
        triggerClassName="text-destructive"
        confirmVariant="destructive"
      />
    </form>
  )
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}
