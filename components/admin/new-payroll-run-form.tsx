"use client"

import { useActionState, useMemo, useState } from "react"
import { Plus } from "lucide-react"

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
  // Re-seed when the prop changes (e.g. owner switches org). Cheap;
  // memo-stable across normal renders.
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const allSelected = selectedIds.length === availablePolicies.length
  const noneSelected = selectedIds.length === 0

  function toggle(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    )
  }

  function toggleAll() {
    setSelectedIds(allSelected ? [] : allIds)
  }

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

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs">Policies in this run</Label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 rounded border-border text-primary"
                />
                Select all
              </label>
            </div>
            <div className="rounded-2xl border border-border/60 bg-surface-low p-2">
              {availablePolicies.map((p) => (
                <label
                  key={p.id}
                  className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm cursor-pointer hover:bg-muted/40"
                >
                  <input
                    type="checkbox"
                    checked={selectedSet.has(p.id)}
                    onChange={() => toggle(p.id)}
                    className="h-4 w-4 rounded border-border text-primary"
                  />
                  <span className="flex-1">{p.name}</span>
                  {p.isDefault ? (
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Default
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
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
