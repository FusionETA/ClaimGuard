"use client"

import { useActionState } from "react"

import {
  revertPayrollRunAction,
  submitPayrollRunAction,
} from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * Submit a draft run. Locks the run as immutable — after this, no
 * more attach/detach/regenerate. Confirms before submitting because
 * the operation is consequential.
 */
export function SubmitPayrollRunButton(props: { runId: string }) {
  const [state, action, pending] = useActionState(
    submitPayrollRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm(
            "Submit this payroll run? After submission, payslips and reimbursements can no longer be edited. You can still revert back to draft if needed.",
          )
        ) {
          e.preventDefault()
        }
      }}
    >
      <input type="hidden" name="runId" value={props.runId} hidden />
      <Button type="submit" disabled={pending}>
        {pending ? "Submitting…" : "Submit run"}
      </Button>
    </form>
  )
}

/**
 * Revert a submitted run back to DRAFT. Used when corrections are
 * needed after submit. Confirms because reverting changes the
 * historical state.
 */
export function RevertPayrollRunButton(props: { runId: string }) {
  const [state, action, pending] = useActionState(
    revertPayrollRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm(
            "Revert this run to draft? Employees who saw a submitted payslip won't see it again until you resubmit.",
          )
        ) {
          e.preventDefault()
        }
      }}
    >
      <input type="hidden" name="runId" value={props.runId} hidden />
      <Button
        type="submit"
        variant="ghost"
        className="text-amber-700"
        disabled={pending}
      >
        {pending ? "Reverting…" : "Revert to draft"}
      </Button>
    </form>
  )
}
