"use client"

import { useActionState } from "react"

import {
  attachClaimToPayrollRunAction,
  detachClaimFromPayrollRunAction,
} from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * "Add to Payroll" button. Renders inline on a row of attachable
 * claims. After success, the page revalidates and the claim moves
 * over to the attached list.
 */
export function AttachClaimButton(props: {
  runId: string
  claimId: string
  size?: "sm" | "default"
}) {
  const [state, action, pending] = useActionState(
    attachClaimToPayrollRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <input type="hidden" name="claimId" value={props.claimId} hidden />
      <Button
        type="submit"
        size={props.size ?? "sm"}
        variant="outline"
        disabled={pending}
      >
        {pending ? "Adding…" : "Add to Payroll"}
      </Button>
    </form>
  )
}

/**
 * "Remove" button for an attached claim. Confirms before detaching
 * — payroll attachments are mostly intentional, but the safety net
 * matches the delete-draft pattern.
 */
export function DetachClaimButton(props: { runId: string; claimId: string }) {
  const [state, action, pending] = useActionState(
    detachClaimFromPayrollRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !window.confirm(
            "Remove this claim from the payroll run? The claim itself isn't deleted.",
          )
        ) {
          e.preventDefault()
        }
      }}
    >
      <input type="hidden" name="runId" value={props.runId} hidden />
      <input type="hidden" name="claimId" value={props.claimId} hidden />
      <Button
        type="submit"
        size="sm"
        variant="ghost"
        className="text-destructive"
        disabled={pending}
      >
        {pending ? "Removing…" : "Remove"}
      </Button>
    </form>
  )
}
