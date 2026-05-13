"use client"

import { useActionState, useId } from "react"

import {
  revertPayrollRunAction,
  submitPayrollRunAction,
} from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { ConfirmSubmitButton } from "@/components/ui/confirm-action-dialog"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * Submit a draft run. Locks the run as immutable — after this, no
 * more attach/detach/regenerate. Confirms before submitting because
 * the operation is consequential.
 */
export function SubmitPayrollRunButton(props: { runId: string }) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    submitPayrollRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <ConfirmSubmitButton
        formId={formId}
        title="Submit payroll run?"
        description="After submission, payslips and reimbursements can no longer be edited. You can still revert back to draft if needed."
        confirmLabel="Submit run"
        triggerLabel="Submit run"
        pendingLabel="Submitting..."
        pending={pending}
      />
    </form>
  )
}

/**
 * Revert a submitted run back to DRAFT. Used when corrections are
 * needed after submit. Confirms because reverting changes the
 * historical state.
 */
export function RevertPayrollRunButton(props: { runId: string }) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    revertPayrollRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <ConfirmSubmitButton
        formId={formId}
        title="Revert run to draft?"
        description="Employees who saw a submitted payslip will not see it again until you resubmit this run."
        confirmLabel="Revert to draft"
        triggerLabel="Revert to draft"
        pendingLabel="Reverting..."
        pending={pending}
        triggerVariant="ghost"
        triggerClassName="text-amber-700"
      />
    </form>
  )
}
