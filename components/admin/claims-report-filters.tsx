"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Check, ChevronDown, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/**
 * Filter bar for the admin claims report page.
 *
 * URL is the source of truth — every change here is applied by pushing
 * a new search-string. The page (server component) reads those params
 * back on the next render and re-runs the report query. Keeps the page
 * bookmarkable and the back/forward buttons functional.
 *
 * Filters supported:
 *   - Date range (two native date inputs).
 *   - Multi-select for projects.
 *   - Multi-select for teams. Caller passes only teams that belong to
 *     the currently-picked projects (cascading scope is resolved
 *     server-side).
 *   - Multi-select for members. Same cascade — only members in the
 *     currently-picked teams (or projects, if no team filter) are
 *     shown.
 *
 * Each multi-select is a hand-rolled popover (button → checkbox list).
 * Closes on outside click or Escape. The list is keyboard-navigable
 * via Tab; we don't add explicit roving-tabindex because the lists
 * here are short (org-scale headcounts).
 */

export type FilterOption = {
  id: string
  /** Display name. */
  name: string
  /** Optional secondary line (e.g. email or project name) shown
   *  underneath the name in muted text. */
  secondary?: string
  /** Optional parent id used for the live cascade. For teams this is
   *  the projectId. */
  parentId?: string
  /** Optional list of parent ids — for members, the teams they
   *  belong to. The cascade match is "any parentId ∈ parentSelection". */
  parentIds?: string[]
}

export type ClaimsReportFiltersProps = {
  /// yyyy-mm-dd as resolved by the server (defaults to the current
  /// month's bounds when no `from`/`to` was in the URL).
  initialFrom: string
  initialTo: string
  /// Which claim timestamp the date range filters on. "spent" matches
  /// receipt purchase date (accounting view, the default); "submitted"
  /// matches the date the employee filed the claim (audit view).
  initialDateField: "spent" | "submitted"
  initialProjectIds: string[]
  initialTeamIds: string[]
  initialMemberIds: string[]
  projectOptions: FilterOption[]
  /// Already scoped to the currently-picked projects by the server.
  teamOptions: FilterOption[]
  /// Already scoped to picked teams (or picked projects) by the server.
  memberOptions: FilterOption[]
}

export function ClaimsReportFilters(props: ClaimsReportFiltersProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [from, setFrom] = useState(props.initialFrom)
  const [to, setTo] = useState(props.initialTo)
  const [dateField, setDateField] = useState<"spent" | "submitted">(
    props.initialDateField,
  )
  const [projectIds, setProjectIds] = useState<string[]>(props.initialProjectIds)
  const [teamIds, setTeamIds] = useState<string[]>(props.initialTeamIds)
  const [memberIds, setMemberIds] = useState<string[]>(props.initialMemberIds)

  // Re-seed local state whenever the URL changes (e.g. back/forward,
  // export link, manual edits). The page passes us the resolved values
  // via initial* props so we just mirror them.
  useEffect(() => {
    setFrom(props.initialFrom)
    setTo(props.initialTo)
    setDateField(props.initialDateField)
    setProjectIds(props.initialProjectIds)
    setTeamIds(props.initialTeamIds)
    setMemberIds(props.initialMemberIds)
  }, [
    props.initialFrom,
    props.initialTo,
    props.initialDateField,
    props.initialProjectIds,
    props.initialTeamIds,
    props.initialMemberIds,
  ])

  function applyFilters() {
    const params = new URLSearchParams()
    if (from) params.set("from", from)
    if (to) params.set("to", to)
    // Only serialise non-default to keep the URL clean — default is
    // "spent" everywhere downstream.
    if (dateField !== "spent") params.set("dateField", dateField)
    if (projectIds.length > 0) params.set("projects", projectIds.join(","))
    if (teamIds.length > 0) params.set("teams", teamIds.join(","))
    if (memberIds.length > 0) params.set("members", memberIds.join(","))
    // Preserve any other params (e.g. page) that the page might use,
    // EXCEPT page itself — changing filters always resets to page 1.
    for (const [k, v] of searchParams.entries()) {
      if (k === "from" || k === "to" || k === "dateField") continue
      if (k === "projects" || k === "teams" || k === "members") continue
      if (k === "page") continue
      params.set(k, v)
    }
    const qs = params.toString()
    router.push(qs ? `/admin/claims/breakdown?${qs}` : "/admin/claims/breakdown")
  }

  function resetFilters() {
    router.push("/admin/claims/breakdown")
  }

  const hasAnyActive =
    projectIds.length > 0 ||
    teamIds.length > 0 ||
    memberIds.length > 0 ||
    from !== props.initialFrom ||
    to !== props.initialTo ||
    dateField !== props.initialDateField

  // LIVE cascade — narrow the visible options based on the IN-STATE
  // parent selection, not the URL. This is what makes the Teams
  // dropdown reflect the just-picked Project instantly, without
  // forcing the admin to click Apply between selections.
  const visibleTeamOptions = useMemo(() => {
    if (projectIds.length === 0) return [] // Dropdown is also disabled.
    const picked = new Set(projectIds)
    return props.teamOptions.filter(
      (t) => !t.parentId || picked.has(t.parentId),
    )
  }, [props.teamOptions, projectIds])

  const visibleMemberOptions = useMemo(() => {
    if (teamIds.length === 0) return [] // Dropdown is also disabled.
    const picked = new Set(teamIds)
    return props.memberOptions.filter((m) => {
      // No parent linkage on this member → fall back to showing them
      // (legacy / loose data). Members WITH linkage must intersect
      // the picked teams.
      if (!m.parentIds || m.parentIds.length === 0) return true
      return m.parentIds.some((tid) => picked.has(tid))
    })
  }, [props.memberOptions, teamIds])

  return (
    <div className="space-y-3 rounded-2xl border border-border/70 bg-card/94 p-4 shadow-ambient">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <div className="space-y-1.5">
          <Label htmlFor="report-from" className="text-xs uppercase tracking-wide text-muted-foreground">
            From
          </Label>
          <Input
            id="report-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="report-to" className="text-xs uppercase tracking-wide text-muted-foreground">
            To
          </Label>
          <Input
            id="report-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label
            htmlFor="report-date-field"
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            Filter by
          </Label>
          {/* Spent = accounting view ("money spent in this period",
              based on the receipt's purchase date). Submitted = audit
              view ("claims filed in this period", which surfaces
              late-filed receipts from earlier months). */}
          <select
            id="report-date-field"
            value={dateField}
            onChange={(e) =>
              setDateField(e.target.value === "submitted" ? "submitted" : "spent")
            }
            className="h-12 w-full rounded-2xl border border-border/80 bg-card px-4 text-sm text-foreground shadow-sm transition-colors hover:bg-surface-low focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background"
          >
            <option value="spent">Spent date</option>
            <option value="submitted">Submitted date</option>
          </select>
        </div>
        <MultiSelect
          label="Projects"
          options={props.projectOptions}
          selectedIds={projectIds}
          onChange={(ids) => {
            setProjectIds(ids)
            // Trim picked teams / members down to ones that still
            // belong under the new project scope. Uses parent linkage
            // when available so the trim mirrors the cascade.
            const newPickedSet = new Set(ids)
            const stillValidTeamIds = new Set(
              props.teamOptions
                .filter((t) => !t.parentId || newPickedSet.has(t.parentId))
                .map((t) => t.id),
            )
            const nextTeamIds = teamIds.filter((id) =>
              stillValidTeamIds.has(id),
            )
            setTeamIds(nextTeamIds)
            const nextTeamSet = new Set(nextTeamIds)
            setMemberIds((prev) =>
              prev.filter((id) => {
                const member = props.memberOptions.find((m) => m.id === id)
                if (!member?.parentIds || member.parentIds.length === 0) return true
                return member.parentIds.some((tid) => nextTeamSet.has(tid))
              }),
            )
          }}
        />
        <MultiSelect
          label="Teams"
          options={visibleTeamOptions}
          selectedIds={teamIds}
          onChange={(ids) => {
            setTeamIds(ids)
            // Same trim for members on the team-pick change.
            const newPickedSet = new Set(ids)
            setMemberIds((prev) =>
              prev.filter((id) => {
                const member = props.memberOptions.find((m) => m.id === id)
                if (!member?.parentIds || member.parentIds.length === 0) return true
                return member.parentIds.some((tid) => newPickedSet.has(tid))
              }),
            )
          }}
          // Strict cascade: can't pick a team until a project is
          // picked. Prevents constructing nonsensical filter combos
          // like "Team X but no project scope".
          disabled={projectIds.length === 0}
          disabledHint="Pick a project first"
          emptyHint={
            visibleTeamOptions.length === 0
              ? "No teams in the selected project(s)."
              : undefined
          }
        />
        <MultiSelect
          label="Members"
          options={visibleMemberOptions}
          selectedIds={memberIds}
          onChange={setMemberIds}
          // Strict cascade: members are scoped to picked teams.
          disabled={teamIds.length === 0}
          disabledHint="Pick a team first"
          emptyHint={
            visibleMemberOptions.length === 0
              ? "No members in the selected team(s)."
              : undefined
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {hasAnyActive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={resetFilters}
          >
            Clear filters
          </Button>
        ) : null}
        <Button type="button" size="sm" onClick={applyFilters}>
          Apply
        </Button>
      </div>
    </div>
  )
}

// ─── MultiSelect ────────────────────────────────────────────────────────────

function MultiSelect({
  label,
  options,
  selectedIds,
  onChange,
  emptyHint,
  disabled,
  disabledHint,
}: {
  label: string
  options: FilterOption[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  emptyHint?: string
  /**
   * When true the button is non-interactive and shown in the muted
   * disabled style. Used to enforce the cascading filter contract
   * (e.g. can't pick a team until a project is picked).
   */
  disabled?: boolean
  /** Placeholder text shown inside a disabled trigger. */
  disabledHint?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)

  // Force-close when the field becomes disabled (e.g. user just cleared
  // the parent project filter while the team popover was open).
  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  // Close on outside click / Escape. We don't use a portal so a simple
  // mousedown listener on document is enough.
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        (o.secondary?.toLowerCase().includes(q) ?? false),
    )
  }, [options, query])

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  function toggle(id: string) {
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((x) => x !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  // Compute the visible button label. Disabled trigger shows the
  // "pick X first" hint so the admin knows WHY the field is locked.
  const buttonLabel = disabled
    ? disabledHint ?? "Locked"
    : selectedIds.length === 0
      ? "All"
      : selectedIds.length === 1
        ? options.find((o) => o.id === selectedIds[0])?.name ?? "1 selected"
        : `${selectedIds.length} selected`

  // Mirrors the styling of `Input` (h-12 rounded-2xl bg-card etc.) so
  // the dropdowns visually line up with the date inputs in the same
  // row. Add the disabled treatment in muted colours.
  const triggerClass = cn(
    "flex h-12 w-full min-w-0 items-center justify-between gap-2",
    "rounded-2xl border border-border/80 bg-card px-4 py-2 text-base text-foreground shadow-sm sm:text-sm",
    "transition-colors hover:bg-surface-low",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background",
    "disabled:cursor-not-allowed disabled:bg-surface-low/60 disabled:text-muted-foreground disabled:hover:bg-surface-low/60",
  )

  return (
    <div className="space-y-1.5" ref={rootRef}>
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            if (disabled) return
            setOpen((v) => !v)
          }}
          disabled={disabled}
          className={triggerClass}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-disabled={disabled}
        >
          <span
            className={cn(
              "truncate",
              (selectedIds.length === 0 || disabled) && "text-muted-foreground",
            )}
          >
            {buttonLabel}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
        {open ? (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-hidden rounded-md border border-border bg-card shadow-lg">
            <div className="border-b border-border/60 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}…`}
                  className="h-8 pl-7 text-xs"
                  // Autofocus the search on open so the admin can
                  // start typing immediately. Wrapped in a setTimeout
                  // implicitly via the open render — React will focus
                  // on mount.
                  autoFocus
                />
              </div>
              {selectedIds.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                  Clear selection ({selectedIds.length})
                </button>
              ) : null}
            </div>
            <ul className="max-h-56 overflow-y-auto py-1" role="listbox" aria-multiselectable>
              {filtered.length === 0 ? (
                <li className="px-3 py-3 text-center text-xs text-muted-foreground">
                  {emptyHint ?? "No matches."}
                </li>
              ) : (
                filtered.map((opt) => {
                  const checked = selectedSet.has(opt.id)
                  return (
                    <li key={opt.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={checked}
                        onClick={() => toggle(opt.id)}
                        className={cn(
                          "flex w-full items-start gap-2 px-3 py-2 text-left text-sm",
                          "hover:bg-surface-low",
                          checked && "bg-primary/5",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                            checked
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-input bg-background",
                          )}
                        >
                          {checked ? <Check className="h-3 w-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-foreground">
                            {opt.name}
                          </span>
                          {opt.secondary ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {opt.secondary}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  )
                })
              )}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}
