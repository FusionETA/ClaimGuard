"use client"

import * as React from "react"
import { useActionState, useEffect, useId, useState } from "react"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"

import {
  approvePayrollRunAction,
  getPayrollSyncPreviewAction,
  rejectPayrollRunApprovalAction,
  retryPayrollRunXeroSyncAction,
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
import { cn } from "@/lib/utils"
import type {
  PayrollSyncPreview,
  PayrollSyncPreviewResult,
} from "@/modules/payroll/application/services/xero-sync-preview.service"

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
 * employees and the run is officially finalised. When Xero sync is
 * enabled, the modal also previews the single Manual Journal that posts
 * immediately on approval, including attached-claim reimbursements.
 * The section is collapsible — the count is always visible; the details
 * unfold on click.
 */
export function ApprovePayrollRunButton(props: { runId: string }) {
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<PayrollSyncPreviewResult | null>(null)
  const [state, action, pending] = useActionState(
    approvePayrollRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  // Load the preview the first time the modal opens (or every open?
  // Run state is stable while in PENDING_APPROVAL, but a re-load on
  // every open keeps numbers fresh if the admin opens/cancels/opens
  // — cheap, all DB-side).
  useEffect(() => {
    if (!open) {
      setPreview(null)
      return
    }
    let cancelled = false
    void (async () => {
      const result = await getPayrollSyncPreviewAction({ runId: props.runId })
      if (!cancelled) setPreview(result)
    })()
    return () => {
      cancelled = true
    }
  }, [open, props.runId])

  // Close on success so the page refreshes into the SUBMITTED state.
  const lastStatus = React.useRef(state.status)
  useEffect(() => {
    if (state.status === "success" && lastStatus.current !== "success") {
      setOpen(false)
    }
    lastStatus.current = state.status
  }, [state])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button">Approve</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Approve and submit payroll run?</DialogTitle>
          <DialogDescription>
            This finalises the run, exposes every payslip to the affected
            employees, and posts the entries below to Xero. You can still
            revert to draft later if corrections are needed.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto pr-1">
          <SyncPreviewPanel preview={preview} />
        </div>

        <form action={action}>
          <input type="hidden" name="runId" value={props.runId} hidden />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? "Approving…" : "Approve and post"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Renders the journal preview inside the approval modal.
 * Three states:
 *   - `preview === null` → still loading.
 *   - `status === "error"` → friendly error, modal still lets the
 *     admin proceed (approval works even if preview fails).
 *   - `status === "success" | "skipped"` → journal section.
 *     "skipped" means the run will land but no Xero post will fire
 *     (e.g. mapping incomplete). Banner explains why.
 */
function SyncPreviewPanel({
  preview,
}: {
  preview: PayrollSyncPreviewResult | null
}) {
  if (preview === null) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        Loading preview…
      </p>
    )
  }
  if (preview.status === "error") {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
        Could not load Xero preview: {preview.message}. Approval will still
        work; sync can be retried later.
      </div>
    )
  }

  const data = preview.preview
  if (!data) return null

  const skippedBanner =
    preview.status === "skipped" ? (
      <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 text-xs dark:border-amber-700/40 dark:bg-amber-950/20">
        <span className="font-medium text-foreground">Xero post skipped:</span>{" "}
        {"message" in preview ? preview.message : ""}
      </div>
    ) : null

  return (
    <div className="space-y-3 py-2">
      {skippedBanner}
      <JournalSection
        journal={data.journal}
        willPost={preview.status === "success"}
      />
    </div>
  )
}

function JournalSection({
  journal,
  willPost,
}: {
  journal: PayrollSyncPreview["journal"]
  willPost: boolean
}) {
  const [open, setOpen] = useState(false)
  const debits = journal.lines.filter((l) => l.amount > 0)
  const credits = journal.lines.filter((l) => l.amount < 0)

  return (
    <SectionToggle
      open={open}
      onToggle={() => setOpen((o) => !o)}
      headline={
        <>
          <span className="font-semibold text-foreground">
            {willPost ? "1" : "0"} Manual Journal
          </span>{" "}
          will {willPost ? "be posted" : "be skipped"}
          <span className="ml-2 text-xs text-muted-foreground">
            · {journal.lines.length} line
            {journal.lines.length === 1 ? "" : "s"} ·{" "}
            {journal.isBalanced ? (
              <span className="text-emerald-700">balanced</span>
            ) : (
              <span className="text-destructive">unbalanced</span>
            )}
          </span>
        </>
      }
    >
      <div className="space-y-3 px-3 py-2 text-xs">
        <div className="text-muted-foreground">
          <div>
            <span className="font-medium text-foreground">Narration:</span>{" "}
            {journal.narration}
          </div>
          <div>
            <span className="font-medium text-foreground">Date:</span>{" "}
            {journal.date}
          </div>
        </div>
        <JournalLineTable title="Debits" lines={debits} />
        <JournalLineTable title="Credits" lines={credits} />
        <div className="flex justify-end gap-6 border-t border-border/60 pt-2 text-[11px] tabular-nums">
          <span>
            <span className="text-muted-foreground">Total debits:</span>{" "}
            <span className="font-mono">{journal.totalDebits.toFixed(2)}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Total credits:</span>{" "}
            <span className="font-mono">{journal.totalCredits.toFixed(2)}</span>
          </span>
        </div>
      </div>
    </SectionToggle>
  )
}

function JournalLineTable({
  title,
  lines,
}: {
  title: string
  lines: PayrollSyncPreview["journal"]["lines"]
}) {
  if (lines.length === 0) return null
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <table className="mt-1 w-full">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="border-t border-border/40">
              <td className="py-1 pr-2 align-top">
                <div className="text-foreground">{line.description}</div>
                <div className="text-[10px] text-muted-foreground">
                  → {line.accountLabel}
                  {line.trackingOption ? ` · ${line.trackingOption}` : ""}
                </div>
              </td>
              <td className="py-1 pl-2 text-right font-mono tabular-nums">
                {Math.abs(line.amount).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SectionToggle({
  open,
  onToggle,
  headline,
  children,
}: {
  open: boolean
  onToggle: () => void
  headline: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card/60">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
          "hover:bg-muted/30",
        )}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1">{headline}</span>
      </button>
      {open ? <div className="border-t border-border/60">{children}</div> : null}
    </div>
  )
}

/**
 * Retry button rendered on the run page when `xeroSyncStatus` is
 * ERROR (or NOT_SYNCED on a SUBMITTED run, e.g. admin disabled sync
 * at approval time and later enabled it). Calls
 * `retryPayrollRunXeroSyncAction` and shows a toast with the result.
 */
export function RetryXeroSyncButton(props: {
  runId: string
  variant?: "default" | "outline"
}) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    retryPayrollRunXeroSyncAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <Button
        type="submit"
        variant={props.variant ?? "outline"}
        size="sm"
        disabled={pending}
        className="gap-2"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", pending && "animate-spin")} />
        {pending ? "Retrying…" : "Retry Xero sync"}
      </Button>
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
export function RevertPayrollRunButton(props: {
  runId: string
  /// Later submitted months (e.g. "June 2026") that reverting this run
  /// will ALSO cascade back to draft, because their YTD figures depend
  /// on this month. Empty when there's nothing downstream.
  laterMonths?: string[]
}) {
  const formId = useId()
  const [state, action, pending] = useActionState(
    revertPayrollRunAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const hasCascade = (props.laterMonths?.length ?? 0) > 0
  const description = hasCascade
    ? `Heads up: ${props.laterMonths!.join(", ")} ${
        props.laterMonths!.length === 1 ? "was" : "were"
      } submitted after this month and will ALSO be reverted to draft — their tax (PCB) and statutory totals are calculated cumulatively from this month, so they must be re-run. Employees won't see any of these payslips again until you resubmit.`
    : "Employees who saw a submitted payslip will not see it again until you resubmit this run."

  return (
    <form id={formId} action={action}>
      <input type="hidden" name="runId" value={props.runId} hidden />
      <ConfirmSubmitButton
        formId={formId}
        title={
          hasCascade
            ? `Revert this and ${props.laterMonths!.length} later month${
                props.laterMonths!.length === 1 ? "" : "s"
              }?`
            : "Revert run to draft?"
        }
        description={description}
        confirmLabel={hasCascade ? "Revert all to draft" : "Revert to draft"}
        triggerLabel="Revert to draft"
        pendingLabel="Reverting..."
        pending={pending}
        triggerVariant="ghost"
        triggerClassName="text-amber-700"
      />
    </form>
  )
}
