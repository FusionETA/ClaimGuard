"use client"

import { useActionState, useMemo, useState } from "react"
import { ChevronDown, ChevronRight, Plus, Search } from "lucide-react"

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
 *
 * The scope block is ONE inline list of policy rows:
 *   [☑ / ☐ include]  [policy name]        [n employees]   [▸ expand]
 * Expanded row reveals its member checkboxes so the admin can drop
 * individual employees from this run without unticking their policy.
 *
 * A search bar filters visible members across every row and
 * auto-expands rows that have matching members while a query is
 * active. Archived employees are filtered server-side and don't
 * appear.
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
  /// list doesn't need a round trip on click. Archived employees are
  /// filtered out server-side.
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(allIds),
  )
  // Excluded employees are a SET so ticking / re-ticking is O(1).
  // When a policy is un-ticked we DON'T clear its members from the
  // exclude set — that way ticking the policy back on preserves the
  // prior per-employee choices. The set is validated server-side
  // against the ticked policies before persistence, so stale ids for
  // un-ticked policies get rejected.
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState("")

  const trimmedQuery = query.trim().toLowerCase()

  function memberMatchesQuery(m: PayrollRunPickerMember) {
    if (!trimmedQuery) return true
    return (
      m.name.toLowerCase().includes(trimmedQuery) ||
      m.employeeId.toLowerCase().includes(trimmedQuery) ||
      m.jobTitle.toLowerCase().includes(trimmedQuery)
    )
  }

  function togglePolicy(policyId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(policyId)) next.delete(policyId)
      else next.add(policyId)
      return next
    })
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

  // "Included" only counts members of TICKED policies who aren't in
  // the exclude set. Un-ticked policies contribute zero regardless of
  // their exclude entries.
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

  // Server accepts a comma-separated list; a policy still in the
  // exclude set but no longer ticked would be dropped by the server-
  // side validation, but stripping here keeps the payload clean.
  const excludedIdsForSubmit = useMemo(() => {
    const out: string[] = []
    for (const pid of selectedIds) {
      for (const m of membersByPolicy[pid] ?? []) {
        if (excluded.has(m.employeeProfileId)) out.push(m.employeeProfileId)
      }
    }
    return out
  }, [selectedIds, membersByPolicy, excluded])

  const selectedIdsForSubmit = useMemo(
    () => [...selectedIds].join(","),
    [selectedIds],
  )

  const noneSelected = selectedIds.size === 0

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      // Reset picker state on close so a re-open starts clean.
      setSelectedIds(new Set(allIds))
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
            Pick the period, tick which policies to include, and
            (optionally) expand a policy to drop specific members from
            this run.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <input type="hidden" name="policyIds" value={selectedIdsForSubmit} />
          <input
            type="hidden"
            name="excludedEmployeeProfileIds"
            value={excludedIdsForSubmit.join(",")}
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
            <div className="flex items-center justify-between">
              <Label className="text-xs">Policies and employees</Label>
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
            <div className="nice-scrollbar -mr-2 max-h-[45vh] space-y-1.5 overflow-y-auto py-1 pl-1 pr-2">
              {availablePolicies.map((p) => {
                const members = membersByPolicy[p.id] ?? []
                const matchingMembers = members.filter(memberMatchesQuery)
                // During a search: hide policies whose members don't
                // match anything (keeps the list tight). Auto-expand
                // rows that DO have matches so results are visible.
                if (trimmedQuery && matchingMembers.length === 0) return null
                const isOpen = trimmedQuery
                  ? matchingMembers.length > 0
                  : expanded.has(p.id)
                const isSelected = selectedIds.has(p.id)
                const excludedInPolicy = members.filter((m) =>
                  excluded.has(m.employeeProfileId),
                ).length
                return (
                  <PolicyRow
                    key={p.id}
                    policyName={p.name}
                    isDefault={p.isDefault}
                    memberCount={members.length}
                    excludedInPolicy={excludedInPolicy}
                    isSelected={isSelected}
                    onTogglePolicy={() => togglePolicy(p.id)}
                    isOpen={isOpen}
                    onToggleExpand={() => toggleExpanded(p.id)}
                    disableExpandToggle={!!trimmedQuery}
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
                          included={
                            isSelected && !excluded.has(m.employeeProfileId)
                          }
                          disabled={!isSelected}
                          onToggle={() => toggleExcluded(m.employeeProfileId)}
                        />
                      ))
                    )}
                  </PolicyRow>
                )
              })}
            </div>
            {noneSelected ? (
              <p className="text-xs text-destructive">
                Pick at least one policy.
              </p>
            ) : includedCount === 0 ? (
              <p className="text-xs text-destructive">
                At least one employee has to be included.
              </p>
            ) : null}
          </div>

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

function PolicyRow(props: {
  policyName: string
  isDefault: boolean
  memberCount: number
  excludedInPolicy: number
  isSelected: boolean
  onTogglePolicy: () => void
  isOpen: boolean
  onToggleExpand: () => void
  /// True while a search query is active — the row's expand state is
  /// driven by whether it has any matching members, so the manual
  /// chevron toggle is disabled to avoid confusing the admin.
  disableExpandToggle: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "rounded-md border bg-card",
        props.isSelected ? "border-border/60" : "border-border/30 opacity-70",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Policy checkbox — ticked policy contributes its members to
            the run. Un-ticking greys out the row + disables member
            checkboxes below (they still render so the admin can see
            who would be in). */}
        <input
          type="checkbox"
          checked={props.isSelected}
          onChange={props.onTogglePolicy}
          className="h-4 w-4"
          aria-label={`Include ${props.policyName}`}
        />
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {props.policyName}
            {props.isDefault ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                (default)
              </span>
            ) : null}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {props.isSelected && props.excludedInPolicy > 0
              ? `${props.memberCount - props.excludedInPolicy} of ${props.memberCount}`
              : `${props.memberCount} employee${props.memberCount === 1 ? "" : "s"}`}
          </span>
        </div>
        <button
          type="button"
          onClick={props.disableExpandToggle ? undefined : props.onToggleExpand}
          disabled={props.disableExpandToggle || props.memberCount === 0}
          className={cn(
            "shrink-0 rounded p-1 text-muted-foreground transition",
            !props.disableExpandToggle &&
              props.memberCount > 0 &&
              "hover:bg-muted/60 hover:text-foreground",
          )}
          aria-label={props.isOpen ? "Collapse" : "Expand"}
        >
          {props.isOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
      </div>
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
  /// True when the parent policy is un-ticked — the member row still
  /// renders but their checkbox is inert. Toggling the parent policy
  /// back on restores the prior per-member state.
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-3 px-3 py-1.5 text-sm transition",
        props.disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer hover:bg-muted/40",
      )}
    >
      <input
        type="checkbox"
        checked={props.included}
        onChange={props.onToggle}
        disabled={props.disabled}
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
        {props.member.isExcluded ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            No salary
          </span>
        ) : null}
      </div>
    </label>
  )
}
