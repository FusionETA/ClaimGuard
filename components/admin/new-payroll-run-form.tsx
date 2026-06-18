"use client"

import { useActionState, useMemo, useState } from "react"
import { Plus } from "lucide-react"

import { AdminAccessPicker } from "@/components/admin/admin-access-picker"
import { createPayrollRunDraftAction } from "@/app/(admin)/admin/payroll/runs/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { NativeSelect } from "@/components/admin/payroll-form-controls"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
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

type PolicyOption = { id: string; name: string; isDefault: boolean }

/**
 * Period + policy-scope picker for starting a new payroll run draft.
 * Opens as a dialog so the policy multi-select has room to breathe.
 * On success the action redirects to the new run's detail page, so we
 * don't need to render anything for the success branch.
 */
export function NewPayrollRunForm({
  defaultYear,
  defaultMonth,
  availablePolicies,
}: {
  defaultYear: number
  defaultMonth: number
  /// Active policies the signed-in admin may scope the run to. For
  /// restricted admins this is already filtered server-side; an empty
  /// array means the admin has no granted policies and can't start a
  /// run at all (we render a disabled trigger + tooltip).
  availablePolicies: PolicyOption[]
}) {
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState(
    createPayrollRunDraftAction,
    initialSettingsActionState,
  )
  useToastOnAction(state)

  const noPoliciesAvailable = availablePolicies.length === 0
  // Default selection = every available policy. Owners get "everyone";
  // restricted admins get exactly their granted set ticked.
  const allIds = useMemo(
    () => availablePolicies.map((p) => p.id),
    [availablePolicies],
  )
  const [selectedIds, setSelectedIds] = useState<string[]>(allIds)
  // Convert the (id, name, isDefault) shape from the server into the
  // `{ value, label }` shape AdminAccessPicker expects. Default policy
  // gets a "(default)" suffix so admins can still tell which one it is
  // without the inline "DEFAULT" pill from the old checkbox list.
  const pickerOptions = useMemo(
    () =>
      availablePolicies.map((p) => ({
        value: p.id,
        label: p.isDefault ? `${p.name} (default)` : p.name,
      })),
    [availablePolicies],
  )
  const noneSelected = selectedIds.length === 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          disabled={noPoliciesAvailable}
          title={
            noPoliciesAvailable
              ? "Your access doesn't include any employee policies."
              : undefined
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          Create draft
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start a new payroll run</DialogTitle>
          <DialogDescription>
            Pick the period and which policies this run covers. Only
            employees in the ticked policies will be included when
            payslips are generated.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <input
            type="hidden"
            name="policyIds"
            value={selectedIds.join(",")}
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="periodMonth" className="text-xs">
                Month
              </Label>
              <NativeSelect
                id="periodMonth"
                name="periodMonth"
                defaultValue={defaultMonth}
                className="w-full"
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
                defaultValue={defaultYear}
                className="w-full"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Policies in this run</Label>
            {/* Same dropdown-style multi-select used by the
                "Manage access" dialog — collapses to a single trigger
                button until clicked, so 1–2 policies don't take up the
                whole form. */}
            <AdminAccessPicker
              label="policies"
              options={pickerOptions}
              value={selectedIds}
              onChange={setSelectedIds}
            />
            {noneSelected ? (
              <p className="text-xs text-destructive">
                Pick at least one policy.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || noneSelected}>
              {pending ? "Creating…" : "Create draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
