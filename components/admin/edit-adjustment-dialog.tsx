"use client"

import { useCallback, useId, useState, useTransition } from "react"
import { Loader2, Sliders } from "lucide-react"

import { fetchAdjustmentForDialogAction } from "@/app/(admin)/admin/payroll/runs/[id]/employees/[empProfileId]/actions"
import {
  ClearAdjustmentButton,
  PayrollAdjustmentForm,
} from "@/components/admin/payroll-adjustment-form"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toaster"
import type { FixedAllowance } from "@/modules/payroll/domain/models"
import type { PayrollRunAdjustmentData } from "@/modules/payroll/domain/runs"

/**
 * Modal wrapper around the per-employee adjustment form.
 *
 * Layout — the dialog is a CSS-grid column with three rows so the
 * action buttons live in a *real* fixed footer (outside the scroll
 * body), not a sticky strip floating inside it:
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ DialogHeader      (auto height, fixed)                 │
 *   ├────────────────────────────────────────────────────────┤
 *   │ Scroll body       (1fr — scrolls when content overflows) │
 *   │  - OT hours card                                       │
 *   │  - One-off line items card                             │
 *   │  - Notes card                                          │
 *   │  - The save <form id=...> wraps all of the above       │
 *   ├────────────────────────────────────────────────────────┤
 *   │ DialogFooter      (auto height, fixed)                 │
 *   │  - Clear adjustments (left)                            │
 *   │  - Save adjustments (right) — `form="<saveFormId>"`    │
 *   └────────────────────────────────────────────────────────┘
 *
 * The Save button submits the form via the HTML5 `form` attribute,
 * so the button can live outside the <form> element in the dialog
 * footer. The form's pending state is reported up via
 * `onPendingChange` so the external button can show "Saving…".
 *
 * Data flow:
 *   1. Trigger button stays in the table row (icon affordance).
 *   2. Opening fires `fetchAdjustmentForDialogAction` which returns
 *      the saved adjustment + fixed allowances. Loaded lazily so the
 *      run detail page doesn't embed N copies of this data on
 *      first render.
 *   3. On save-success the form fires `onSaved`, the dialog closes.
 *      `revalidatePath` in the server action refreshes the parent
 *      page, so the table picks up the new numbers automatically.
 */
export function EditAdjustmentDialog({
  runId,
  employeeProfileId,
  employeeName,
  employeeCode,
  readOnly,
}: {
  runId: string
  employeeProfileId: string
  employeeName: string
  employeeCode: string
  /// True when the run is already SUBMITTED — form is render-only.
  readOnly: boolean
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{
    adjustment: PayrollRunAdjustmentData | null
    fixedAllowances: FixedAllowance[]
  } | null>(null)
  const [loading, startLoading] = useTransition()
  /// Pending state lifted from the form so the dialog-footer's Save
  /// button can disable itself + show "Saving…" while the action
  /// resolves. The form fires `onPendingChange` whenever its
  /// `useActionState` pending bit flips.
  const [savePending, setSavePending] = useState(false)
  /// Stable id shared between the form element (rendered in the
  /// scroll body) and the Save button (rendered in the dialog
  /// footer). Browsers wire them together via the HTML5 `form`
  /// attribute.
  const saveFormId = useId()

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (next && !data) {
        startLoading(async () => {
          const result = await fetchAdjustmentForDialogAction({
            runId,
            employeeProfileId,
          })
          if (!result) {
            toast({
              title: "Could not load adjustments for this employee.",
              variant: "error",
            })
            setOpen(false)
            return
          }
          setData(result)
        })
      }
    },
    [data, runId, employeeProfileId, toast],
  )

  const showFooter = !readOnly && !!data

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        title={readOnly ? "View OT / adjustments" : "Edit OT / adjustments"}
        aria-label="Adjust"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
      >
        <Sliders className="h-3 w-3" />
      </DialogTrigger>
      <DialogContent
        className={
          // Override the default centred-with-padding dialog so we can
          // wire a true grid: header / scrollable body / fixed footer.
          // Each row is `auto` / `1fr` / `auto`; the middle row
          // scrolls when the form is taller than the dialog. p-0
          // because each row provides its own padding.
          "grid max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-h-[88vh] sm:max-w-[min(94vw,960px)] sm:overflow-hidden sm:p-0"
        }
      >
        <DialogHeader className="border-b border-border/60 px-6 pb-4 pt-6 sm:px-7 sm:pt-7">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sliders className="h-4 w-4 text-primary" />
            {readOnly ? "View" : "Edit"} adjustments — {employeeName}{" "}
            <span className="text-xs font-normal text-muted-foreground">
              {employeeCode}
            </span>
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? "This run is submitted — the form is read-only. Revert it to draft to make changes."
              : "Edit OT hours, override recurring allowances for this run, add one-off line items, and leave a note. Changes apply only to the next regeneration of this run."}
          </DialogDescription>
        </DialogHeader>

        {/* Middle row — scrolls when content exceeds available
            height. min-h-0 is required on grid items that should
            shrink below their content size. */}
        <div className="min-h-0 overflow-y-auto px-6 py-4 sm:px-7">
          {loading || !data ? (
            <div className="flex h-40 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : (
            <PayrollAdjustmentForm
              runId={runId}
              employeeProfileId={employeeProfileId}
              adjustment={data.adjustment}
              fixedAllowances={data.fixedAllowances}
              readOnly={readOnly}
              saveFormId={saveFormId}
              hideActions
              onPendingChange={setSavePending}
              onSaved={() => {
                // Close the dialog on a successful save. The toast
                // already shows confirmation; the parent table picks
                // up the refreshed numbers via revalidatePath.
                setOpen(false)
                // Drop cached data so re-opening reloads fresh —
                // otherwise we'd show pre-save figures until next
                // mount.
                setData(null)
              }}
            />
          )}
        </div>

        {/* Fixed footer — sits in the bottom grid row, always
            visible regardless of scroll position. Solid bg + top
            border give a clean separation from the scrolling body. */}
        {showFooter ? (
          <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-card px-6 py-3 sm:px-7">
            {data.adjustment ? (
              <ClearAdjustmentButton
                runId={runId}
                employeeProfileId={employeeProfileId}
              />
            ) : (
              <span />
            )}
            <Button
              type="submit"
              form={saveFormId}
              disabled={savePending}
              className="min-w-[160px]"
            >
              {savePending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save adjustments"
              )}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
