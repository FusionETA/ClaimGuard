"use client"

import { useActionState, useId } from "react"

import {
  attachClaimToPayrollRunAction,
  detachClaimFromPayrollRunAction,
} from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import { ConfirmSubmitButton } from "@/components/ui/confirm-action-dialog"
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
 * "Remove" button for an attached claim. Confirms in-app before detaching.
 */
export function DetachClaimButton(props: { runId: string; claimId: string }) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    detachClaimFromPayrollRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <input type="hidden" name="claimId" value={props.claimId} hidden />
      <ConfirmSubmitButton
        formId={formId}
        title="Remove claim from payroll?"
        description="The claim itself will not be deleted. It will only be detached from this payroll run."
        confirmLabel="Remove"
        triggerLabel="Remove"
        pendingLabel="Removing..."
        pending={pending}
        triggerSize="sm"
        triggerVariant="ghost"
        triggerClassName="text-destructive"
        confirmVariant="destructive"
      />
    </form>
  )
}
