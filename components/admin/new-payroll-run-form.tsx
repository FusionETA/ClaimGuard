"use client"

import { useActionState, useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Plus, Search } from "lucide-react"

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
import { cn } from "@/lib/utils"
import type { PayrollRunPickerMember } from "@/modules/payroll/application/services/payroll-run.service"

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
 *
 * Two layers of scoping:
 *   1. Policies — tick which policies this run covers.
 *   2. Per-employee — each ticked policy is expandable; unticking a
 *      member adds them to the exclude list (persisted as
 *      `excludedEmployeeProfileIds` on the run).
 *
 * A search bar at the top filters visible members across every ticked
 * policy, auto-expanding matching policy sections while the query is
 * non-empty.
 */
export function NewPayrollRunForm({
  defaultYear,
  defaultMonth,
  availablePolicies,
  membersByPolicy,
}: {
  defaultYear: number
  defaultMonth: number
  /// Active policies the signed-in admin may scope the run to. For
  /// restricted admins this is already filtered server-side; an empty
  /// array means the admin has no granted policies and can't start a
  /// run at all (we render a disabled trigger + tooltip).
  availablePolicies: PolicyOption[]
  /// Members grouped by policyId. Preloaded so the expand-per-policy
  /// list doesn't need a round trip on click. Missing policyId keys
  /// mean "no members" (rendered as a "no employees" hint).
  membersByPolicy: Record<string, PayrollRunPickerMember[]>
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
  const pickerOptions = useMemo(
    () =>
      availablePolicies.map((p) => ({
        value: p.id,
        label: p.isDefault ? `${p.name} (default)` : p.name,
      })),
    [availablePolicies],
  )
  const noneSelected = selectedIds.length === 0

  // Excluded employees are a SET so an admin unticking someone then
  // re-ticking them is O(1) and idempotent. Cleared when the policy
  // that owned them is unticked below.
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")

  // When a policy is unticked, drop its members from the exclude set —
  // they're already implicitly excluded by the policy-scope filter, and
  // keeping them in the list would surface as a phantom exclusion if
  // the admin re-ticks the policy later.
  useEffect(() => {
    setExcluded((prev) => {
      if (prev.size === 0) return prev
      const stillValid = new Set<string>()
      for (const pid of selectedIds) {
        for (const m of membersByPolicy[pid] ?? []) {
          if (prev.has(m.employeeProfileId)) {
            stillValid.add(m.employeeProfileId)
          }
        }
      }
      if (stillValid.size === prev.size) return prev
      return stillValid
    })
  }, [selectedIds, membersByPolicy])

  const trimmedQuery = query.trim().toLowerCase()

  // Case-insensitive substring match across name / employeeId / job
  // title. Empty query = no filtering (all members visible under each
  // expanded policy).
  function memberMatchesQuery(m: PayrollRunPickerMember) {
    if (!trimmedQuery) return true
    return (
      m.name.toLowerCase().includes(trimmedQuery) ||
      m.employeeId.toLowerCase().includes(trimmedQuery) ||
      m.jobTitle.toLowerCase().includes(trimmedQuery)
    )
  }

  function toggleExpanded(policyId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(policyId)) next.delete(policyId)
      else next.add(policyId)
      return next
    })
  }

  function toggleExcluded(employeeProfileId: string) {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(employeeProfileId)) next.delete(employeeProfileId)
      else next.add(employeeProfileId)
      return next
    })
  }

  // Count included = for each ticked policy, count members not in
  // the exclude set. Drives the "X of Y employees will be included"
  // hint under the section header.
  const { includedCount, totalCount } = useMemo(() => {
    let included = 0
    let total = 0
    for (const pid of selectedIds) {
      for (const m of membersByPolicy[pid] ?? []) {
        total += 1
        if (!excluded.has(m.employeeProfileId)) included += 1
      }
    }
    return { includedCount: included, totalCount: total }
  }, [selectedIds, membersByPolicy, excluded])

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      // Reset picker state on close so a re-open starts clean.
      setSelectedIds(allIds)
      setExcluded(new Set())
      setExpanded(new Set())
      setQuery("")
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Start a new payroll run</DialogTitle>
          <DialogDescription>
            Pick the period, which policies this run covers, and
            (optionally) untick individual employees you want to leave
            out this month.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <input
            type="hidden"
            name="policyIds"
            value={selectedIds.join(",")}
          />
          <input
            type="hidden"
            name="excludedEmployeeProfileIds"
            value={[...excluded].join(",")}
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

          {!noneSelected && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Employees in this run</Label>
                <span className="text-xs text-muted-foreground">
                  {includedCount} of {totalCount} included
                </span>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name, employee ID, or job title"
                  className="h-10 pl-9"
                />
              </div>
              <div className="nice-scrollbar -mr-2 max-h-[40vh] space-y-1.5 overflow-y-auto py-1 pl-1 pr-2">
                {selectedIds.map((pid) => {
                  const policy = availablePolicies.find((p) => p.id === pid)
                  const members = membersByPolicy[pid] ?? []
                  const matchingMembers = members.filter(memberMatchesQuery)
                  // Auto-expand while searching so results are visible
                  // without clicking. Manual expand toggle applies when
                  // the query is empty.
                  const isOpen = trimmedQuery
                    ? matchingMembers.length > 0
                    : expanded.has(pid)
                  // Hide policies with zero matches during a search —
                  // avoids a sea of collapsed "0 matches" rows.
                  if (trimmedQuery && matchingMembers.length === 0) return null
                  const excludedInPolicy = members.filter((m) =>
                    excluded.has(m.employeeProfileId),
                  ).length
                  return (
                    <PolicySection
                      key={pid}
                      policyName={policy?.name ?? "(unknown policy)"}
                      isDefault={policy?.isDefault ?? false}
                      memberCount={members.length}
                      excludedInPolicy={excludedInPolicy}
                      isOpen={isOpen}
                      onToggle={() => toggleExpanded(pid)}
                      disabledToggle={!!trimmedQuery}
                    >
                      {matchingMembers.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-muted-foreground">
                          No employees under this policy yet.
                        </p>
                      ) : (
                        matchingMembers.map((m) => (
                          <MemberRow
                            key={m.employeeProfileId}
                            member={m}
                            included={!excluded.has(m.employeeProfileId)}
                            onToggle={() =>
                              toggleExcluded(m.employeeProfileId)
                            }
                          />
                        ))
                      )}
                    </PolicySection>
                  )
                })}
              </div>
              {includedCount === 0 ? (
                <p className="text-xs text-destructive">
                  At least one employee has to be included.
                </p>
              ) : null}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || noneSelected || includedCount === 0}
            >
              {pending ? "Creating…" : "Create draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Internals ─────────────────────────────────────────────────────

function PolicySection(props: {
  policyName: string
  isDefault: boolean
  memberCount: number
  excludedInPolicy: number
  isOpen: boolean
  onToggle: () => void
  disabledToggle: boolean
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-border/60 bg-card">
      <button
        type="button"
        onClick={props.disabledToggle ? undefined : props.onToggle}
        disabled={props.disabledToggle}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition",
          !props.disabledToggle && "hover:bg-muted/40",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          {props.isOpen ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-medium text-foreground">
            {props.policyName}
            {props.isDefault ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                (default)
              </span>
            ) : null}
          </span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {props.excludedInPolicy > 0
            ? `${props.memberCount - props.excludedInPolicy} of ${props.memberCount}`
            : `${props.memberCount} employee${props.memberCount === 1 ? "" : "s"}`}
        </span>
      </button>
      {props.isOpen && (
        <div className="border-t border-border/60 py-1.5">
          {props.children}
        </div>
      )}
    </div>
  )
}

function MemberRow(props: {
  member: PayrollRunPickerMember
  included: boolean
  onToggle: () => void
}) {
  const disabled = props.member.isArchived
  return (
    <label
      className={cn(
        "flex items-center gap-3 px-3 py-1.5 text-sm transition",
        disabled ? "opacity-50" : "cursor-pointer hover:bg-muted/40",
      )}
    >
      <input
        type="checkbox"
        checked={props.included}
        onChange={props.onToggle}
        disabled={disabled}
        className="h-4 w-4"
      />
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-foreground">
            {props.member.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {props.member.employeeId} · {props.member.jobTitle}
          </span>
        </div>
        {props.member.isArchived ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            Archived
          </span>
        ) : props.member.isExcluded ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            No salary
          </span>
        ) : null}
      </div>
    </label>
  )
}
