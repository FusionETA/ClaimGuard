"use client"

import { useActionState, useId } from "react"

import { generatePayrollPayslipsAction } from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import { ConfirmSubmitButton } from "@/components/ui/confirm-action-dialog"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * Runs/re-runs payroll for a payroll run. Re-clicking the button after
 * editing employee profiles or the org's settings recomputes every
 * payslip from scratch.
 */
export function GeneratePayslipsButton(props: {
  runId: string
  hasExisting: boolean
}) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    generatePayrollPayslipsAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const label = props.hasExisting ? "Re-run payroll" : "Run payroll"

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      {props.hasExisting ? (
        <ConfirmSubmitButton
          formId={formId}
          title="Re-run payroll?"
          description="Payroll will be recalculated from the current profiles and settings. Existing payslips on this run will be replaced."
          confirmLabel="Re-run payroll"
          triggerLabel={label}
          pendingLabel="Running payroll..."
          pending={pending}
        />
      ) : (
        <Button type="submit" disabled={pending}>
          {pending ? "Running payroll..." : label}
        </Button>
      )}
    </form>
  )
}
