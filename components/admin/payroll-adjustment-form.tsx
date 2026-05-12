"use client"

import { useActionState, useState } from "react"
import { Plus, Trash2 } from "lucide-react"

import {
  clearPayrollAdjustmentAction,
  savePayrollAdjustmentAction,
} from "@/app/(admin)/admin/payroll/runs/[id]/employees/[empProfileId]/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
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
  readOnly: boolean
}) {
  const [state, action, pending] = useActionState(
    savePayrollAdjustmentAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const [lines, setLines] = useState<ManualLineItem[]>(
    props.adjustment?.manualLineItems ?? [],
  )

  function addLine(kind: "ALLOWANCE" | "DEDUCTION") {
    setLines((cs) => [...cs, { kind, label: "", amount: 0 }])
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
    <form action={action} className="space-y-6">
      <input type="hidden" name="runId" value={props.runId} hidden />
      <input
        type="hidden"
        name="employeeProfileId"
        value={props.employeeProfileId}
        hidden
      />

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unpaid leave</CardTitle>
          <CardDescription>
            Manually-entered MYR deduction. Auto-computed once the leave
            integration ships in v2.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field label="Unpaid leave deduction (MYR)">
            <Input
              name="unpaidLeaveDeduction"
              type="number"
              step="0.01"
              min="0"
              max="1000000"
              defaultValue={props.adjustment?.unpaidLeaveDeduction ?? 0}
              disabled={props.readOnly}
            />
          </Field>
        </CardContent>
      </Card>

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

      {!props.readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {props.adjustment ? (
            <ClearAdjustmentButton
              runId={props.runId}
              employeeProfileId={props.employeeProfileId}
            />
          ) : (
            <span />
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save adjustments"}
          </Button>
        </div>
      )}
    </form>
  )
}

function LineRow(props: {
  index: number
  line: ManualLineItem
  onChange: (p: Partial<ManualLineItem>) => void
  onRemove: () => void
  readOnly: boolean
}) {
  return (
    <div className="grid items-end gap-3 rounded-lg border border-border/60 bg-muted/30 p-3 md:grid-cols-[1fr_160px_auto]">
      <input
        type="hidden"
        name={`line${props.index}.kind`}
        value={props.line.kind}
        hidden
      />
      <Field label="Label">
        <Input
          name={`line${props.index}.label`}
          value={props.line.label}
          onChange={(e) => props.onChange({ label: e.target.value })}
          placeholder={
            props.line.kind === "ALLOWANCE"
              ? "Bonus / one-off allowance"
              : "Salary advance / late fee"
          }
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
  )
}

function ClearAdjustmentButton(props: {
  runId: string
  employeeProfileId: string
}) {
  const [state, action, pending] = useActionState(
    clearPayrollAdjustmentAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm(
            "Clear all adjustments for this employee on this run? OT hours, one-off line items, and unpaid-leave deductions will all be reset to zero.",
          )
        ) {
          e.preventDefault()
        }
      }}
    >
      <input type="hidden" name="runId" value={props.runId} hidden />
      <input
        type="hidden"
        name="employeeProfileId"
        value={props.employeeProfileId}
        hidden
      />
      <Button
        type="submit"
        variant="ghost"
        className="text-destructive"
        disabled={pending}
      >
        {pending ? "Clearing…" : "Clear all adjustments"}
      </Button>
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
