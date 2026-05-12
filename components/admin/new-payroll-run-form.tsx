"use client"

import { useActionState } from "react"

import { createPayrollRunDraftAction } from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { NativeSelect } from "@/components/admin/payroll-form-controls"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToastOnAction } from "@/components/ui/toaster"

const MONTHS = [
  { value: 1, label: "January" },
  { value: 2, label: "February" },
  { value: 3, label: "March" },
  { value: 4, label: "April" },
  { value: 5, label: "May" },
  { value: 6, label: "June" },
  { value: 7, label: "July" },
  { value: 8, label: "August" },
  { value: 9, label: "September" },
  { value: 10, label: "October" },
  { value: 11, label: "November" },
  { value: 12, label: "December" },
] as const

/**
 * Period picker for starting a new payroll run draft. On success the
 * action redirects to the new run's detail page, so we don't need to
 * render anything for the success branch.
 */
export function NewPayrollRunForm(props: {
  defaultYear: number
  defaultMonth: number
}) {
  const [state, action, pending] = useActionState(
    createPayrollRunDraftAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="periodMonth" className="text-xs">
          Month
        </Label>
        <NativeSelect
          id="periodMonth"
          name="periodMonth"
          defaultValue={props.defaultMonth}
          className="w-44"
        >
          {MONTHS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="periodYear" className="text-xs">
          Year
        </Label>
        <Input
          id="periodYear"
          name="periodYear"
          type="number"
          min="2000"
          max="2099"
          defaultValue={props.defaultYear}
          className="w-28"
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create draft"}
      </Button>
    </form>
  )
}
