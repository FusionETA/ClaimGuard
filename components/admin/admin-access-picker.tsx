"use client"

import * as React from "react"
import { Check, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Top-level admin modules an owner can grant/revoke. Source of truth
 * for the access picker's option list AND the small "current access"
 * badges on each admin row.
 *
 * Keep this in sync with the admin sidebar nav — every link in
 * `components/layout/admin-shell.tsx` should map to a module here.
 * (Once the schema lands we'll add a server-side gate keyed off the
 * same enum so an admin missing a module can't load the page either.)
 *
 * Claims is split into Personal (employee-reimbursement) and Company
 * (company-paid) because many orgs have different admins running
 * those two flows. The key prefixes match the `PaymentType` enum on
 * the Claim model so the eventual server-side gate maps cleanly.
 */
export const ADMIN_MODULES = [
  { value: "claims_personal", label: "Claims — Personal (reimbursement)" },
  { value: "claims_company", label: "Claims — Company (company-paid)" },
  { value: "payroll", label: "Payroll" },
  { value: "leave", label: "Leave" },
  { value: "attendance", label: "Attendance" },
  { value: "hierarchy", label: "Manage Employee" },
  { value: "company_structure", label: "Company structure" },
  { value: "audit_log", label: "Audit log" },
  { value: "settings", label: "Settings" },
] as const

export type AdminModuleKey = (typeof ADMIN_MODULES)[number]["value"]

/**
 * Modules that operate on the WHOLE organization — historically these
 * locked the "Policies" picker to All because their underlying flow is
 * org-level (one payroll run includes everyone, etc.). The lock was
 * removed at the owner's request: even for org-wide modules, an owner
 * may want to scope WHAT the admin previews / reviews to specific
 * policies (e.g. grant Payroll access but only show "Office Workers"
 * employees in the preview). Server-side enforcement of org-wide flows
 * is unaffected — those routes ignore the policy scope at runtime.
 *
 * Kept as an empty array (instead of deleted) so existing helpers +
 * call sites compile, and we can re-enable per-module locks later
 * without touching consumers.
 */
export const ORG_WIDE_MODULES: ReadonlyArray<AdminModuleKey> = []

/// True iff the selected modules include any that force policy access
/// to "all". UI uses this to disable + override the policies picker.
export function arePoliciesLocked(modules: ReadonlyArray<string>): boolean {
  const set = new Set(modules)
  return ORG_WIDE_MODULES.some((m) => set.has(m))
}

/// The list of org-wide module *labels* currently in `modules` —
/// surfaced in the explanatory note so the owner knows why the
/// policies picker is locked.
export function orgWideModuleLabels(
  modules: ReadonlyArray<string>,
): string[] {
  const set = new Set(modules)
  return ADMIN_MODULES.filter(
    (m) =>
      (ORG_WIDE_MODULES as ReadonlyArray<string>).includes(m.value) &&
      set.has(m.value),
  ).map((m) => m.label)
}

/// In-memory shape of an admin's access. UI-first prototype: not
/// persisted yet. When the schema lands this becomes the shape the
/// server-action accepts.
export type AdminAccess = {
  modules: AdminModuleKey[]
  policyIds: string[]
}

/// Convenience: a brand-new admin defaults to FULL access (matches
/// today's "all admins are equal-tier" behaviour). Owners can then
/// uncheck modules / policies before saving.
export function fullAccess(allPolicyIds: string[]): AdminAccess {
  return {
    modules: ADMIN_MODULES.map((m) => m.value),
    policyIds: allPolicyIds,
  }
}

/**
 * Inline multi-select dropdown with a "Select all" toggle. Used for
 * both the Modules picker and the Policies picker on the admin-access
 * forms. Keeps the popover anchored under the trigger button, closes
 * on outside-click or Escape.
 *
 * Self-contained — no headless-ui / radix popover dependency, so it
 * works in any context (invite form, edit dialog, etc.).
 */
export function AdminAccessPicker(props: {
  /// Single-word label used in the summary text, e.g. "modules" or
  /// "policies". Will be lowercased automatically — pass the noun form.
  label: string
  options: ReadonlyArray<{ value: string; label: string }>
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const allCheckboxRef = React.useRef<HTMLInputElement | null>(null)
  const valueSet = React.useMemo(() => new Set(props.value), [props.value])
  const allSelected =
    props.options.length > 0 && props.value.length === props.options.length
  const noneSelected = props.value.length === 0
  const someSelected = !allSelected && !noneSelected

  // Tri-state indeterminate isn't a React prop — set it imperatively.
  React.useEffect(() => {
    if (allCheckboxRef.current) {
      allCheckboxRef.current.indeterminate = someSelected
    }
  }, [someSelected])

  // Close on outside-click + Escape.
  React.useEffect(() => {
    if (!open) return
    const handleMouse = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", handleMouse)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handleMouse)
      document.removeEventListener("keydown", handleKey)
    }
  }, [open])

  function toggle(v: string) {
    if (valueSet.has(v)) {
      props.onChange(props.value.filter((x) => x !== v))
    } else {
      props.onChange([...props.value, v])
    }
  }
  function toggleAll() {
    props.onChange(allSelected ? [] : props.options.map((o) => o.value))
  }

  const labelLower = props.label.toLowerCase()
  const summary = allSelected
    ? `All ${labelLower}`
    : noneSelected
      ? `No ${labelLower}`
      : `${props.value.length} of ${props.options.length} ${labelLower}`

  return (
    <div
      ref={containerRef}
      className={cn("relative w-full", props.className)}
    >
      <button
        type="button"
        onClick={() => !props.disabled && setOpen((o) => !o)}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-left text-sm shadow-sm transition hover:border-input/80 focus:outline-none focus:ring-2 focus:ring-ring",
          props.disabled && "cursor-not-allowed opacity-60",
          noneSelected && !props.disabled && "border-destructive/50",
        )}
      >
        <span
          className={cn(
            "truncate",
            noneSelected ? "text-destructive" : "text-foreground",
          )}
        >
          {summary}
        </span>
        <ChevronDown
          className={cn(
            "ml-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div
          role="listbox"
          className="absolute z-50 mt-1 w-full overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <label className="flex cursor-pointer items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-foreground">
            <input
              ref={allCheckboxRef}
              type="checkbox"
              className="h-4 w-4 cursor-pointer rounded border-border/70 accent-primary"
              checked={allSelected}
              onChange={toggleAll}
            />
            Select all
          </label>
          <ul className="nice-scrollbar max-h-60 overflow-y-auto p-1">
            {props.options.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">
                Nothing to pick from yet.
              </li>
            ) : (
              props.options.map((o) => {
                const checked = valueSet.has(o.value)
                return (
                  <li key={o.value}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer rounded border-border/70 accent-primary"
                        checked={checked}
                        onChange={() => toggle(o.value)}
                      />
                      <span className="flex-1">{o.label}</span>
                      {checked ? (
                        <Check className="h-3.5 w-3.5 text-primary" />
                      ) : null}
                    </label>
                  </li>
                )
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Tiny chip-row summarising an admin's current access. Renders inline
 * next to the admin's name in the list — one chip per "bucket" (modules,
 * policies) showing either "All" or "N/M".
 */
export function AccessSummaryChips(props: {
  access: AdminAccess
  totalPolicies: number
}) {
  const moduleAll = props.access.modules.length === ADMIN_MODULES.length
  const policiesLocked = arePoliciesLocked(props.access.modules)
  // When an org-wide module is selected the policy chip always reads
  // "All policies" — that's the effective access even if the stored
  // policyIds is a subset.
  const policyAll =
    policiesLocked ||
    (props.totalPolicies > 0 &&
      props.access.policyIds.length === props.totalPolicies)
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
      <span
        className={cn(
          "rounded-full px-2 py-0.5",
          moduleAll
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        )}
      >
        {moduleAll
          ? "All modules"
          : `${props.access.modules.length}/${ADMIN_MODULES.length} modules`}
      </span>
      <span
        className={cn(
          "rounded-full px-2 py-0.5",
          policyAll
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        )}
        title={
          policiesLocked
            ? "Org-wide modules selected — all policies granted automatically"
            : undefined
        }
      >
        {policyAll
          ? "All policies"
          : `${props.access.policyIds.length}/${props.totalPolicies} policies`}
      </span>
    </div>
  )
}
