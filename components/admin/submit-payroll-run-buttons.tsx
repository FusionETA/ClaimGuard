"use client"

import * as React from "react"
import { useActionState, useId } from "react"

import {
  approvePayrollRunAction,
  rejectPayrollRunApprovalAction,
  revertPayrollRunAction,
  submitPayrollRunForApprovalAction,
} from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import { ConfirmSubmitButton } from "@/components/ui/confirm-action-dialog"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * Submit a DRAFT run *for approval*. Locks the run from edits and parks
 * it in PENDING_APPROVAL — a second admin (or the same admin) then has
 * to click "Approve" before payslips become visible to employees.
 *
 * When `disabled` is true (typically because the run is "stale" —
 * adjustments or claim attachments have changed since the last
 * Generate), the button is greyed out and the title hint tells the
 * admin to re-run payroll first.
 */
export function SubmitPayrollRunButton(props: {
  runId: string
  /// Render the button disabled with a stale-data hint. Used when
  /// the page-data service flags `isStale: true`. Defaults to false.
  disabled?: boolean
  disabledHint?: string
}) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    submitPayrollRunForApprovalAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <ConfirmSubmitButton
        formId={formId}
        title="Submit run for approval?"
        description="The run will be locked from edits and another admin needs to approve it before payslips are released to employees. You can still send it back to draft if any adjustments are needed."
        confirmLabel="Submit for approval"
        triggerLabel="Submit for approval"
        pendingLabel="Submitting..."
        pending={pending}
        disabled={props.disabled}
        triggerTitle={
          props.disabled ? props.disabledHint : undefined
        }
      />
    </form>
  )
}

/**
 * Step 2 of the two-step approval flow. Approver flips a
 * PENDING_APPROVAL run to SUBMITTED — payslips become visible to
 * employees and the run is officially finalised.
 */
export function ApprovePayrollRunButton(props: { runId: string }) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    approvePayrollRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <ConfirmSubmitButton
        formId={formId}
        title="Approve and submit payroll run?"
        description="This finalises the run and exposes every payslip to the affected employees. You can still revert back to draft if corrections are needed later."
        confirmLabel="Approve and submit"
        triggerLabel="Approve"
        pendingLabel="Approving..."
        pending={pending}
      />
    </form>
  )
}

/**
 * Approver bounces a PENDING_APPROVAL run back to DRAFT, optionally
 * leaving a reason for the submitter. Reason is persisted on the run
 * and shown to the original submitter as a hint above the run's
 * editing surface.
 */
export function SendBackToDraftButton(props: { runId: string }) {
  const [open, setOpen] = React.useState(false)
  const [state, action, pending] = useActionState(
    rejectPayrollRunApprovalAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  // Close the dialog on success so the submitter (or admin) sees the
  // run-detail page refresh into its DRAFT state. Depend on the state
  // reference (not state.status) so repeat submissions still fire —
  // see useToastOnAction for the rationale. The lastStatus ref
  // prevents firing on initial mount.
  const lastStatus = React.useRef(state.status)
  React.useEffect(() => {
    if (state.status === "success" && lastStatus.current !== "success") {
      setOpen(false)
    }
    lastStatus.current = state.status
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" className="text-amber-700">
          Send back to draft
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send run back to draft?</DialogTitle>
          <DialogDescription>
            The submitter will be able to edit the run again. Leave an
            optional reason so they know what to fix before resubmitting.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-3">
          <input type="hidden" name="runId" value={props.runId} hidden />
          <div className="space-y-1.5">
            <label
              htmlFor="reject-reason"
              className="text-xs font-medium text-muted-foreground"
            >
              Reason (optional)
            </label>
            <Textarea
              id="reject-reason"
              name="reason"
              placeholder="e.g. OT hours for Aisyah look wrong — please double-check."
              maxLength={500}
              disabled={pending}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="default"
              className="bg-amber-600 hover:bg-amber-600/90"
              disabled={pending}
            >
              {pending ? "Sending..." : "Send back to draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
