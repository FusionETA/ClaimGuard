"use client"

import { useActionState } from "react"

import { deletePayrollRunDraftAction } from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * Inline delete-draft form. Confirms with a native confirm() before
 * submitting — payroll deletion is rare and a single warning is
 * proportional to the impact.
 */
export function DeletePayrollRunDraftButton(props: { runId: string }) {
  const [state, action, pending] = useActionState(
    deletePayrollRunDraftAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm(
            "Delete this draft payroll run? Any payroll results for it will be removed.",
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
        className="text-destructive"
        disabled={pending}
      >
        {pending ? "Deleting…" : "Delete draft"}
      </Button>
    </form>
  )
}
