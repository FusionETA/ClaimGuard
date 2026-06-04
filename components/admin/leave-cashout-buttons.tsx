"use client"

import { useActionState, useId } from "react"

import {
  attachLeaveCashoutToRunAction,
  detachLeaveCashoutFromRunAction,
} from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import { ConfirmSubmitButton } from "@/components/ui/confirm-action-dialog"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * "Add to Payroll" button on an Available expired-leave row.
 * Submits the attach action and revalidates the page on success.
 *
 * Mirrors `AttachClaimButton` 1:1 — same form / toast / disabled
 * behaviour — so the two inline rows feel identical to admins.
 */
export function AttachLeaveCashoutButton(props: {
  runId: string
  entitlementId: string
  disabled?: boolean
  disabledReason?: string
}) {
  const [state, action, pending] = useActionState(
    attachLeaveCashoutToRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <input
        type="hidden"
        name="entitlementId"
        value={props.entitlementId}
        hidden
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending || props.disabled}
        title={props.disabled ? props.disabledReason : undefined}
      >
        {pending ? "Adding…" : "Add to Payroll"}
      </Button>
    </form>
  )
}

/**
 * "Remove" button for a leave cash-out that was already attached.
 * Confirms in-app before detaching. Clears the LeaveEntitlement
 * backlink so the row reappears in "Available to attach".
 */
export function DetachLeaveCashoutButton(props: {
  runId: string
  entitlementId: string
}) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    detachLeaveCashoutFromRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <input
        type="hidden"
        name="entitlementId"
        value={props.entitlementId}
        hidden
      />
      <ConfirmSubmitButton
        formId={formId}
        title="Remove leave cash-out from payroll?"
        description="The expired-leave row will become available to attach again. The employee won't be paid out for those days unless you re-attach (here or to a later run)."
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
