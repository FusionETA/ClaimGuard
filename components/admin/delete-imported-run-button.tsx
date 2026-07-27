"use client"

import { useActionState, useId } from "react"

import { deleteImportedRunAction } from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { ConfirmSubmitButton } from "@/components/ui/confirm-action-dialog"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * Delete a single imported (YTD-migration) payroll run. Confirms in-app
 * before submitting. Only rendered for runs with source = IMPORTED —
 * removing one lets the admin correct a wrongly-imported month without
 * re-uploading the whole year. Employee salary + salary-change history
 * are untouched.
 */
export function DeleteImportedRunButton(props: { runId: string }) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    deleteImportedRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <ConfirmSubmitButton
        formId={formId}
        title="Delete imported payroll run?"
        description="This removes the imported payslips for this month. It does not change any employee's salary or salary history. This cannot be undone."
        confirmLabel="Delete imported run"
        triggerLabel="Delete imported run"
        pendingLabel="Deleting..."
        pending={pending}
        triggerVariant="ghost"
        triggerClassName="text-destructive"
        confirmVariant="destructive"
      />
    </form>
  )
}
