"use client"

import { useActionState } from "react"

import { generatePayrollPayslipsAction } from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Button } from "@/components/ui/button"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * Generate/regenerate payslips for a payroll run. Re-clicking the
 * button after editing employee profiles or the org's settings
 * recomputes every payslip from scratch.
 */
export function GeneratePayslipsButton(props: {
  runId: string
  hasExisting: boolean
}) {
  const [state, action, pending] = useActionState(
    generatePayrollPayslipsAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const label = props.hasExisting ? "Regenerate payslips" : "Generate payslips"

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          props.hasExisting &&
          !window.confirm(
            "Recompute all payslips from the current profiles and settings? Any existing payslips on this run will be replaced.",
          )
        ) {
          e.preventDefault()
        }
      }}
    >
      <input type="hidden" name="runId" value={props.runId} hidden />
      <Button type="submit" disabled={pending}>
        {pending ? "Generating…" : label}
      </Button>
    </form>
  )
}
