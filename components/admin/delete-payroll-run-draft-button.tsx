"use client"

import { useActionState, useId } from "react"

import { deletePayrollRunDraftAction } from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { ConfirmSubmitButton } from "@/components/ui/confirm-action-dialog"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * Inline delete-draft form. Confirms in-app before submitting.
 */
export function DeletePayrollRunDraftButton(props: { runId: string }) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    deletePayrollRunDraftAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <ConfirmSubmitButton
        formId={formId}
        title="Delete draft payroll run?"
        description="Any payroll results for this draft will be removed. This cannot be undone."
        confirmLabel="Delete draft"
        triggerLabel="Delete draft"
        pendingLabel="Deleting..."
        pending={pending}
        triggerVariant="ghost"
        triggerClassName="text-destructive"
        confirmVariant="destructive"
      />
    </form>
  )
}
