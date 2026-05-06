"use client"

import { useActionState, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import { useSearchParams, useRouter } from "next/navigation"
import { CalendarDays, Clock, Coins, Download, Loader2, MapPin, Plus, Search, Trash2 } from "lucide-react"

import { CURRENCY_CATALOG } from "@/lib/currencies"

import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import {
  createCustomAccountAction,
  createManualProjectAction,
  deleteCustomAccountAction,
  deleteManualProjectAction,
  saveAccountLimitAction,
  saveClaimRunSettingsAction,
  saveCurrencySettingsAction,
  saveMileageAccountsAction,
  saveMileageDefaultsAction,
  saveOrganizationSettingsAction,
  saveOtRatesAction,
  toggleOrgOtAction,
  saveGeofenceRadiusAction,
  saveOrgTimezoneAction,
  saveOrgWorkingHoursAction,
  saveProjectCalendarAction,
  addProjectHolidayAction,
  deleteProjectHolidayAction,
  importProjectHolidaysAction,
  saveSelectableAccountsAction,
  saveSelectedBankAccountsAction,
  selectXeroTenantAction,
  switchActiveXeroConnectionAction,
  syncXeroAccountsAction,
  syncXeroProjectsAction,
  updateProjectAction,
} from "@/app/(admin)/admin/settings/actions"
import { XeroConnectionCard } from "@/components/admin/xero-connection-card"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ComingSoonCard } from "@/components/ui/coming-soon-card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast, useToastOnAction } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import type { XeroTenant } from "@/lib/xero"
import type { AdminProfile } from "@/modules/claims/domain/models"
import { TIMEZONE_OPTIONS } from "@/modules/attendance/domain/timezone"
import type {
  ChartOfAccountOption,
  OrganizationMember,
  OrganizationProjectOption,
  OrganizationSummary,
  XeroConnectionSummary,
} from "@/modules/organization/domain/models"

type TabKey = "organization" | "accounts" | "projects" | "work-schedule" | "leave"
type WorkScheduleSection = "ot-rates" | "calendar"

/** Lat/Lng pair inputs used for project geofence setup.
 *  - In edit (controlled) mode: pass defaultLat/defaultLng + onChange.
 *  - In create-form (uncontrolled) mode: omit onChange — the inputs submit
 *    directly via name="latitude" / name="longitude" to the server action. */
function CoordinatePairInputs({
  defaultLat = null,
  defaultLng = null,
  onChange,
  className,
}: {
  defaultLat?: number | null
  defaultLng?: number | null
  onChange?: (lat: number | null, lng: number | null) => void
  className?: string
}) {
  const [lat, setLat] = useState<string>(defaultLat != null ? String(defaultLat) : "")
  const [lng, setLng] = useState<string>(defaultLng != null ? String(defaultLng) : "")
  const [locating, setLocating] = useState(false)

  function emit(nextLat: string, nextLng: string) {
    if (!onChange) return
    const la = nextLat.trim() === "" ? Number.NaN : Number.parseFloat(nextLat)
    const lo = nextLng.trim() === "" ? Number.NaN : Number.parseFloat(nextLng)
    onChange(Number.isFinite(la) ? la : null, Number.isFinite(lo) ? lo : null)
  }

  function update(nextLat: string, nextLng: string) {
    setLat(nextLat)
    setLng(nextLng)
    emit(nextLat, nextLng)
  }

  function handleUseMyLocation() {
    if (!navigator.geolocation) return
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        update(pos.coords.latitude.toFixed(6), pos.coords.longitude.toFixed(6))
        setLocating(false)
      },
      () => setLocating(false),
      { timeout: 8000, maximumAge: 0 },
    )
  }

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="latitude"
          type="number"
          inputMode="decimal"
          step="any"
          min={-90}
          max={90}
          placeholder="Latitude"
          value={lat}
          onChange={(e) => update(e.target.value, lng)}
          className="h-9 w-32 text-sm"
        />
        <Input
          name="longitude"
          type="number"
          inputMode="decimal"
          step="any"
          min={-180}
          max={180}
          placeholder="Longitude"
          value={lng}
          onChange={(e) => update(lat, e.target.value)}
          className="h-9 w-32 text-sm"
        />
        <button
          type="button"
          onClick={handleUseMyLocation}
          disabled={locating}
          title="Use my current location"
          className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
        >
          {locating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MapPin className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">My location</span>
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Open Google Maps, right-click the project location, then click the
        <span className="mx-1 font-mono">1.234567, 103.456789</span>
        coordinates at the top of the menu to copy. Paste them into the two
        fields. Or tap <span className="font-semibold">My location</span> if
        you&apos;re already on site.
      </p>
    </div>
  )
}

/** Sub-pill state inside the Accounts tab. */
type AccountsSubTab = "selectable" | "banks" | "mileage"

/**
 * Map deep-link ?tab= values (including legacy ones) to the new top-level
 * tab + an optional Accounts sub-pill. Keeps existing bookmarks working.
 */
function resolveTabFromInitial(initial?: string): {
  tab: TabKey
  accountsSub: AccountsSubTab
} {
  switch (initial) {
    case "organization":
    case "runs": // legacy → moved into Organization
      return { tab: "organization", accountsSub: "selectable" }
    case "accounts":
      return { tab: "accounts", accountsSub: "selectable" }
    case "banks": // legacy → Accounts → Bank pill
      return { tab: "accounts", accountsSub: "banks" }
    case "mileage": // legacy → Accounts → Mileage pill
      return { tab: "accounts", accountsSub: "mileage" }
    case "projects":
      return { tab: "projects", accountsSub: "selectable" }
    case "attendance":
    case "work-schedule":
      return { tab: "work-schedule", accountsSub: "selectable" }
    case "leave":
      return { tab: "leave", accountsSub: "selectable" }
    default:
      return { tab: "organization", accountsSub: "selectable" }
  }
}

/**
 * Searchable multi-select dropdown. Click the trigger to open a popup
 * with a search input and a filtered list of options; clicking an option
 * toggles its selection. The popup auto-closes on outside-click.
 *
 * Use when a multi-select needs to scale past a handful of options — the
 * search makes long supervisor / PM lists usable. For short lists, a
 * flat checkbox group is fine.
 */
function SearchableMultiSelect({
  options,
  selectedIds,
  onToggle,
  disabled,
  placeholder,
  emptyText = "No matches",
  noOptionsText = "Nothing to pick",
}: {
  options: Array<{ id: string; label: string }>
  selectedIds: string[]
  onToggle: (id: string) => void
  disabled?: boolean
  placeholder: string
  emptyText?: string
  noOptionsText?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const selectedOptions = options.filter((o) => selectedIds.includes(o.id))
  const triggerLabel =
    selectedOptions.length === 0
      ? placeholder
      : selectedOptions.length <= 2
        ? selectedOptions.map((o) => o.label).join(", ")
        : `${selectedOptions[0]!.label} +${selectedOptions.length - 1}`

  const trimmedQuery = query.trim().toLowerCase()
  const filtered = trimmedQuery
    ? options.filter((o) => o.label.toLowerCase().includes(trimmedQuery))
    : options

  // Close on outside click. Auto-focus search when opened.
  useEffect(() => {
    function handleDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setQuery("")
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleDown)
      // Defer focus a tick so the input is mounted.
      const t = setTimeout(() => inputRef.current?.focus(), 10)
      return () => {
        document.removeEventListener("mousedown", handleDown)
        clearTimeout(t)
      }
    }
    return undefined
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled || options.length === 0}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-2xl border border-border/80 bg-card px-3 py-2 text-left text-sm text-foreground shadow-sm transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className={cn(
            "truncate",
            selectedOptions.length === 0 ? "text-muted-foreground" : "",
          )}
        >
          {options.length === 0 ? noOptionsText : triggerLabel}
        </span>
        <span className="text-[10px] font-semibold text-muted-foreground">
          {selectedIds.length > 0 ? `${selectedIds.length} selected` : ""}
        </span>
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+0.4rem)] z-50 rounded-2xl border border-border/80 bg-card p-2 shadow-panel">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="h-9 w-full rounded-xl border border-border/70 bg-background pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          {/* Cap at ~5 visible rows; the rest scrolls. Avoids the popup
              ballooning when a team has many supervisors. */}
          <div className="mt-1.5 max-h-[200px] space-y-0.5 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                {emptyText}
              </p>
            ) : (
              filtered.map((o) => {
                const checked = selectedIds.includes(o.id)
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => onToggle(o.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition",
                      checked
                        ? "bg-primary/8 text-foreground"
                        : "text-muted-foreground hover:bg-surface-low/80",
                    )}
                  >
                    <span className="truncate">{o.label}</span>
                    {checked ? (
                      <span className="text-[10px] font-semibold uppercase text-primary">
                        Selected
                      </span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ProjectCard({
  project,
  members,
  onUpdate,
  onDelete,
}: {
  project: OrganizationProjectOption
  members: OrganizationMember[]
  onUpdate: (
    id: string,
    projectManagerIds: string[],
    location: string | undefined,
    latitude: number | null,
    longitude: number | null
  ) => void
  onDelete?: (id: string) => void
}) {
  // Multi-select PM state. Prefilled from the project's join-table-backed
  // managers list; falls back to the legacy single PM if the join table is
  // empty (handles a fresh schema before the backfill ran).
  const [pmIds, setPmIds] = useState<string[]>(() => {
    if (project.projectManagers && project.projectManagers.length > 0) {
      return project.projectManagers.map((pm) => pm.userId)
    }
    return project.projectManagerId ? [project.projectManagerId] : []
  })
  const [coords, setCoords] = useState<{ lat: number | null; lng: number | null }>({
    lat: project.latitude ?? null,
    lng: project.longitude ?? null,
  })
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    await onUpdate(project.id, pmIds, undefined, coords.lat, coords.lng)
    setSaving(false)
  }

  const supervisorMembers = members.filter(
    (m) => m.role === "SUPERVISOR",
  )

  return (
    <div className="rounded-[20px] border border-border/70 bg-surface-low p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-bold text-foreground">{project.name}</p>
          {project.status ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{project.status}</p>
          ) : null}
        </div>
        {onDelete ? (
          <button
            type="button"
            onClick={() => onDelete(project.id)}
            className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Project managers
        </p>
        <SearchableMultiSelect
          options={supervisorMembers.map((m) => ({ id: m.id, label: m.name }))}
          selectedIds={pmIds}
          onToggle={(id) =>
            setPmIds((prev) =>
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
            )
          }
          placeholder="Pick project managers"
          emptyText="No supervisor matches that name"
          noOptionsText="No supervisors yet — add some first"
        />
        {pmIds.length > 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {pmIds.length} manager{pmIds.length === 1 ? "" : "s"} selected
          </p>
        ) : null}
      </div>
      <CoordinatePairInputs
        defaultLat={project.latitude ?? null}
        defaultLng={project.longitude ?? null}
        onChange={(lat, lng) => setCoords({ lat, lng })}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="rounded-xl w-full"
        onClick={handleSave}
        disabled={saving}
      >
        {saving ? <><Loader2 className="mr-2 h-3 w-3 animate-spin" />Saving…</> : "Save"}
      </Button>
    </div>
  )
}

export function AdminSettingsPanel({
  admin,
  organization,
  xeroConnection,
  chartAccounts,
  customAccounts,
  projects,
  members,
  activeXeroConnectionId,
  xeroStatus,
  xeroReason,
  pendingTenants,
  takenTenantIds = [],
  workingHours,
  timezone,
  initialTab,
  initialSection,
}: {
  admin: AdminProfile
  organization?: OrganizationSummary
  xeroConnection: XeroConnectionSummary
  chartAccounts: ChartOfAccountOption[]
  customAccounts: ChartOfAccountOption[]
  projects: OrganizationProjectOption[]
  members: OrganizationMember[]
  activeXeroConnectionId?: string
  xeroStatus?: string
  xeroReason?: string
  pendingTenants?: XeroTenant[]
  takenTenantIds?: string[]
  workingHours: { start: string; end: string }
  timezone: string
  initialTab?: string
  initialSection?: string
}) {
  const { toast } = useToast()
  const initialResolved = resolveTabFromInitial(initialTab)
  const [activeTab, setActiveTab] = useState<TabKey>(initialResolved.tab)
  const [accountsSubTab, setAccountsSubTab] = useState<AccountsSubTab>(
    initialResolved.accountsSub
  )
  const [workScheduleSection, setWorkScheduleSection] = useState<WorkScheduleSection>(
    initialSection === "calendar" ? "calendar" : "ot-rates"
  )

  useEffect(() => {
    if (!initialTab) return
    const resolved = resolveTabFromInitial(initialTab)
    if (resolved.tab !== activeTab) setActiveTab(resolved.tab)
    if (resolved.tab === "accounts" && resolved.accountsSub !== accountsSubTab) {
      setAccountsSubTab(resolved.accountsSub)
    }
    if (resolved.tab === "work-schedule") {
      const next: WorkScheduleSection = initialSection === "calendar" ? "calendar" : "ot-rates"
      if (next !== workScheduleSection) setWorkScheduleSection(next)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab, initialSection])
  const [accountTypeFilter, setAccountTypeFilter] = useState<string>("all")
  const [accountSearch, setAccountSearch] = useState("")
  const [projectSearch, setProjectSearch] = useState("")
  // Search/filter for the Spend Limits card. By default we hide accounts that
  // don't have a limit set — admins with many accounts shouldn't have to scroll
  // past every row to review the few that have policy.
  const [limitSearch, setLimitSearch] = useState("")
  const [limitTypeFilter, setLimitTypeFilter] = useState<string>("all")
  const [limitOnlyConfigured, setLimitOnlyConfigured] = useState<boolean>(true)
  // Search/filter for the Mileage-eligible accounts card. Same reasoning.
  const [mileageSearch, setMileageSearch] = useState("")
  const [mileageTypeFilter, setMileageTypeFilter] = useState<string>("all")
  const [mileageOnlyEnabled, setMileageOnlyEnabled] = useState<boolean>(true)
  const [switchPending, startSwitch] = useTransition()

  // Custom mode = no Xero connections exist at all
  const isCustomMode = xeroConnection.connections.length === 0
  const activeConnection = xeroConnection.connections.find((c) => c.id === activeXeroConnectionId)

  // In Xero mode BANK-type accounts live on the Bank accounts tab — keep this
  // list expense-only. In custom mode users still see their BANK rows here so
  // they can manage/delete them.
  const displayAccounts = isCustomMode
    ? customAccounts
    : chartAccounts.filter((a) => a.type !== "BANK")
  const accountTypes = Array.from(
    new Set(displayAccounts.map((a) => a.type).filter(Boolean) as string[])
  ).sort()

  const accountSearchLower = accountSearch.toLowerCase()
  const projectSearchLower = projectSearch.toLowerCase()

  const [organizationState, organizationAction, organizationPending] = useActionState(
    saveOrganizationSettingsAction,
    initialSettingsActionState
  )
  const [accountsState, accountsAction, accountsPending] = useActionState(
    saveSelectableAccountsAction,
    initialSettingsActionState
  )
  const [claimRunState, claimRunAction, claimRunPending] = useActionState(
    saveClaimRunSettingsAction,
    initialSettingsActionState
  )
  const [currencyState, currencyAction, currencyPending] = useActionState(
    saveCurrencySettingsAction,
    initialSettingsActionState
  )
  const [xeroState, xeroAction, xeroPending] = useActionState(
    syncXeroAccountsAction,
    initialSettingsActionState
  )
  const [projectsState, projectsAction, projectsPending] = useActionState(
    syncXeroProjectsAction,
    initialSettingsActionState
  )
  const [selectTenantState, selectTenantAction, selectTenantPending] = useActionState(
    selectXeroTenantAction,
    initialSettingsActionState
  )
  const [createAccountState, createAccountAction, createAccountPending] = useActionState(
    createCustomAccountAction,
    initialSettingsActionState
  )
  const [selectedBankState, selectedBankAction, selectedBankPending] = useActionState(
    saveSelectedBankAccountsAction,
    initialSettingsActionState
  )
  const [createProjectState, createProjectAction, createProjectPending] = useActionState(
    createManualProjectAction,
    initialSettingsActionState
  )
  const [mileageDefaultsState, mileageDefaultsAction, mileageDefaultsPending] =
    useActionState(saveMileageDefaultsAction, initialSettingsActionState)
  const [mileageAccountsState, mileageAccountsAction, mileageAccountsPending] =
    useActionState(saveMileageAccountsAction, initialSettingsActionState)
  const [limitState, limitAction, limitPending] = useActionState(
    saveAccountLimitAction,
    initialSettingsActionState
  )

  // Toast on every server-action state transition. The hook handles the
  // success/error branch + dep-array internally, so each action only needs
  // one line. Replaces 14 hand-rolled `useEffect`s.
  useToastOnAction(organizationState)
  useToastOnAction(accountsState)
  useToastOnAction(claimRunState)
  useToastOnAction(currencyState)
  useToastOnAction(xeroState)
  useToastOnAction(projectsState)
  useToastOnAction(selectTenantState)
  useToastOnAction(createAccountState)
  useToastOnAction(selectedBankState)
  useToastOnAction(createProjectState)
  useToastOnAction(mileageDefaultsState)
  useToastOnAction(mileageAccountsState)
  useToastOnAction(limitState)

  function handleSwitchConnection(connectionId: string) {
    startSwitch(() => switchActiveXeroConnectionAction(connectionId))
  }

  async function handleDeleteCustomAccount(id: string) {
    const result = await deleteCustomAccountAction(id)
    if (result.ok) {
      toast({ title: result.message, variant: "success" })
    } else {
      toast({ title: result.message, variant: "error" })
    }
  }

  async function handleDeleteProject(id: string) {
    const result = await deleteManualProjectAction(id)
    if (result.ok) {
      toast({ title: result.message, variant: "success" })
    } else {
      toast({ title: result.message, variant: "error" })
    }
  }

  async function handleUpdateProject(
    projectId: string,
    projectManagerIds: string[],
    location: string | undefined,
    latitude: number | null,
    longitude: number | null
  ) {
    const result = await updateProjectAction(
      projectId,
      projectManagerIds,
      location,
      latitude,
      longitude,
    )
    if (result.ok) {
      toast({ title: result.message, variant: "success" })
    } else {
      toast({ title: result.message, variant: "error" })
    }
  }

  const settingsTabs = [
    ["organization", "Organization"],
    ["accounts", "Accounts"],
    ["projects", "Projects"],
    ["work-schedule", "Work Schedule"],
    ["leave", "Leave"],
  ] as const

  const accountsSubTabs = [
    ["selectable", "Selectable"],
    ["banks", "Bank accounts"],
    ["mileage", "Mileage"],
  ] as const

  return (
    <div className="flex flex-col gap-6">
      {/* Mobile: scrollable pill sub-nav (desktop handled by sidebar).
          Using flex+gap rather than space-y-* on the wrapper so that
          when this nav is display:none on desktop it doesn't push the
          first content card down with an unwanted margin-top. */}
      <nav className="-mx-6 overflow-x-auto px-6 lg:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-2 pb-0.5">
          {settingsTabs.map(([value, label]) => (
            <Link
              key={value}
              href={`/admin/settings?tab=${value}`}
              onClick={() => setActiveTab(value as TabKey)}
              className={cn(
                "shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors",
                activeTab === value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/60 bg-card text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </Link>
          ))}
        </div>
      </nav>

      {activeTab === "organization" ? (
        <div className="space-y-6">
          <XeroConnectionCard connection={xeroConnection} status={xeroStatus} reason={xeroReason} />

          {xeroStatus === "select-tenant" && pendingTenants && pendingTenants.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Select a Xero organisation</CardTitle>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Multiple organisations were found. Select the one to connect — the rest will be
                  disconnected automatically.
                </p>
              </CardHeader>
              <CardContent>
                <form action={selectTenantAction} className="space-y-4">
                  <div className="space-y-3">
                    {pendingTenants.map((tenant) => {
                      const isTaken = takenTenantIds.includes(tenant.tenantId)
                      return (
                        <label
                          key={tenant.tenantId}
                          className={[
                            "flex items-start gap-3 rounded-[20px] border border-border/70 bg-surface-low p-4",
                            isTaken
                              ? "cursor-not-allowed opacity-50"
                              : "cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5",
                          ].join(" ")}
                        >
                          <input
                            type="radio"
                            name="tenantId"
                            value={tenant.tenantId}
                            disabled={isTaken}
                            className="mt-1 h-4 w-4 border-border text-primary focus:ring-primary disabled:cursor-not-allowed"
                            required
                          />
                          <div>
                            <p className="font-bold text-foreground">{tenant.tenantName}</p>
                            <p className="mt-0.5 text-sm text-muted-foreground">
                              {[tenant.tenantType, tenant.tenantId].filter(Boolean).join(" · ")}
                            </p>
                            {isTaken ? (
                              <p className="mt-1 text-xs font-medium text-amber-600">
                                Already connected to another organisation
                              </p>
                            ) : null}
                          </div>
                        </label>
                      )
                    })}
                  </div>

                  {selectTenantState.status === "error" ? (
                    <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
                      {selectTenantState.message}
                    </p>
                  ) : null}

                  <Button type="submit" className="rounded-xl" disabled={selectTenantPending}>
                    {selectTenantPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Connecting…
                      </>
                    ) : (
                      "Connect selected organisation"
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Organization profile</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-[24px] bg-surface-low p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Current company
                </p>
                <p className="mt-2 text-lg font-black text-foreground">
                  {organization?.name ?? activeConnection?.tenantName ?? "No company selected"}
                </p>
                {activeConnection?.tenantName ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Linked Xero organization: {activeConnection.tenantName}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">
                    This company is currently using custom accounts and projects.
                  </p>
                )}
              </div>

              <form action={organizationAction} className="space-y-4">
                <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                  <span>
                    Organization name
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground/70">
                      {xeroConnection.connections.length > 0
                        ? "(optional override for this company)"
                        : "(optional)"}
                    </span>
                  </span>
                  <Input
                    name="organizationName"
                    defaultValue={xeroConnection.connections.length > 0 ? "" : (organization?.name ?? admin.organizationName ?? "")}
                    placeholder={
                      xeroConnection.connections.length > 0
                        ? xeroConnection.connections[0]?.tenantName ?? "From Xero"
                        : "e.g. Acme Sdn Bhd"
                    }
                    disabled={organizationPending}
                  />
                </label>

                <Button type="submit" className="rounded-xl" disabled={organizationPending}>
                  Save organization
                </Button>
              </form>

              {/* Connect to Xero prompt — shown only when org exists but no Xero connected */}
              {organization && isCustomMode ? (
                <div className="rounded-[20px] border border-dashed border-border p-5 space-y-3">
                  <p className="text-sm font-semibold text-muted-foreground">Connect to Xero?</p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Link this company to Xero to sync chart of accounts, bank accounts, and projects.
                    Existing custom accounts and manual projects will be hidden, not deleted, once Xero takes over.
                  </p>
                  <Button asChild variant="outline" className="rounded-xl">
                    <a href="/api/xero/connect">Connect to Xero</a>
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Claim run cutoff — moved here from the standalone "Claim runs" tab. */}
          <Card>
            <CardHeader>
              <CardTitle>Claim run cutoff</CardTitle>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Claims submitted on or before this day stay in the current month&apos;s
                claims run. Claims submitted after the cutoff still go through, but
                they roll into the next run.
              </p>
            </CardHeader>
            <CardContent>
              <form action={claimRunAction} className="grid gap-3 sm:grid-cols-[200px_auto] sm:items-end">
                <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                  <span>Cutoff day of month</span>
                  <Input
                    name="claimCutoffDay"
                    type="number"
                    min="1"
                    max="28"
                    defaultValue={organization?.claimCutoffDay ?? 25}
                    disabled={claimRunPending}
                  />
                </label>
                <Button type="submit" className="rounded-xl" disabled={claimRunPending}>
                  {claimRunPending ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
                  ) : (
                    "Save claim run cutoff"
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Currency settings — drives the picker on the employee claim form. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Coins className="h-5 w-5 text-primary" />
                Currencies
              </CardTitle>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Pick which currencies your employees can submit claims in, and which one is the
                default. Receipts in any other currency will need to be converted before submission.
              </p>
            </CardHeader>
            <CardContent>
              <CurrencySettingsForm
                action={currencyAction}
                pending={currencyPending}
                initialAllowed={organization?.allowedCurrencies ?? []}
                initialDefault={organization?.defaultCurrency}
              />
            </CardContent>
          </Card>

        </div>
      ) : null}

      {activeTab === "accounts" ? (
        <div className="space-y-6">
          {/* Sub-pill nav inside the merged Accounts tab. */}
          <nav className="-mx-6 overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="flex gap-2 pb-0.5">
              {accountsSubTabs.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setAccountsSubTab(value)}
                  className={cn(
                    "shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors",
                    accountsSubTab === value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border/60 bg-card text-muted-foreground hover:text-foreground"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </nav>
        </div>
      ) : null}

      {activeTab === "accounts" && accountsSubTab === "selectable" ? (
        <div className="space-y-6">

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>
                  {isCustomMode ? "Custom claim accounts" : `Claim accounts — ${activeConnection?.tenantName ?? "Xero"}`}
                </CardTitle>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {isCustomMode
                    ? "Create and manage your own chart of accounts for employees without a Xero connection."
                    : "Pull chart of accounts from Xero, then choose which accounts employees can use during claim submission."}
                </p>
              </div>
              {!isCustomMode && activeXeroConnectionId ? (
                <form action={xeroAction}>
                  <input type="hidden" name="connectionId" value={activeXeroConnectionId} />
                  <Button type="submit" variant="outline" className="rounded-xl" disabled={xeroPending}>
                    {xeroPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Syncing…
                      </>
                    ) : (
                      "Sync Xero accounts"
                    )}
                  </Button>
                </form>
              ) : null}
            </CardHeader>
            <CardContent>
              {/* Custom account creation form */}
              {isCustomMode ? (
                <div className="space-y-6">
                  <form action={createAccountAction} className="space-y-3">
                    <p className="text-sm font-semibold text-muted-foreground">Add custom account</p>
                    <div className="flex flex-wrap gap-3">
                      <Input
                        name="code"
                        placeholder="Code (e.g. 200)"
                        className="w-32"
                        required
                      />
                      <Input
                        name="name"
                        placeholder="Account name"
                        className="flex-1 min-w-[180px]"
                        required
                      />
                      <Input
                        name="type"
                        placeholder="Type (optional)"
                        className="w-36"
                      />
                      <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                        <input type="checkbox" name="isSelectable" value="true" className="h-4 w-4 rounded border-border text-primary" />
                        Selectable
                      </label>
                    </div>
                    <Button type="submit" variant="outline" className="rounded-xl" disabled={createAccountPending}>
                      {createAccountPending ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Adding…</>
                      ) : (
                        <><Plus className="mr-2 h-4 w-4" />Add account</>
                      )}
                    </Button>
                  </form>

                  {displayAccounts.length === 0 ? (
                    <div className="rounded-[24px] bg-surface-low p-5 text-sm leading-6 text-muted-foreground">
                      No custom accounts yet. Add one above.
                    </div>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      {displayAccounts.map((account) => (
                        <div
                          key={account.id}
                          className="flex items-start justify-between gap-3 rounded-[20px] border border-border/70 bg-surface-low p-4"
                        >
                          <div>
                            <p className="font-bold text-foreground">
                              {account.code} · {account.name}
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {[account.type, account.isSelectable ? "Selectable" : "Hidden"].filter(Boolean).join(" · ")}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDeleteCustomAccount(account.id)}
                            className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                            aria-label={`Delete ${account.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : displayAccounts.length === 0 ? (
                <div className="rounded-[24px] bg-surface-low p-5 text-sm leading-6 text-muted-foreground">
                  No chart of accounts have been imported yet. Use the Sync button to import from Xero.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search by code or name…"
                      value={accountSearch}
                      onChange={(e) => setAccountSearch(e.target.value)}
                      className="pl-9"
                    />
                  </div>

                  {accountTypes.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant={accountTypeFilter === "all" ? "default" : "ghost"}
                        className="rounded-full"
                        onClick={() => setAccountTypeFilter("all")}
                      >
                        All
                      </Button>
                      {accountTypes.map((type) => (
                        <Button
                          key={type}
                          type="button"
                          variant={accountTypeFilter === type ? "default" : "ghost"}
                          className="rounded-full"
                          onClick={() => setAccountTypeFilter(type)}
                        >
                          {type.charAt(0) + type.slice(1).toLowerCase()}
                        </Button>
                      ))}
                    </div>
                  ) : null}

                  <form action={accountsAction} className="space-y-4">
                    <input type="hidden" name="connectionId" value={activeXeroConnectionId ?? ""} />
                    <div className="grid gap-3 md:grid-cols-2">
                      {displayAccounts.map((account) => {
                        const matchesType = accountTypeFilter === "all" || account.type === accountTypeFilter
                        const matchesSearch =
                          accountSearchLower === "" ||
                          account.code.toLowerCase().includes(accountSearchLower) ||
                          account.name.toLowerCase().includes(accountSearchLower)
                        return (
                          <label
                            key={account.id}
                            className={[
                              "flex items-start gap-3 rounded-[20px] border border-border/70 bg-surface-low p-4",
                              !matchesType || !matchesSearch ? "hidden" : "",
                            ]
                              .join(" ")
                              .trim()}
                          >
                            <input
                              type="checkbox"
                              name="chartAccountIds"
                              value={account.id}
                              defaultChecked={account.isSelectable}
                              className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                            />
                            <div>
                              <p className="font-bold text-foreground">
                                {account.code} · {account.name}
                              </p>
                              <p className="mt-1 text-sm text-muted-foreground">
                                {[account.type, account.status].filter(Boolean).join(" · ") || "Available"}
                              </p>
                            </div>
                          </label>
                        )
                      })}
                    </div>

                    <Button type="submit" className="rounded-xl" disabled={accountsPending}>
                      Save selectable accounts
                    </Button>
                  </form>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Per-account spend limit editor — applies to whichever accounts the
              admin has marked selectable (or custom). Filtering: defaults to
              showing only accounts that already have a limit so the page stays
              short on COAs with hundreds of accounts; flip the toggle to add a
              limit on a new account. */}
          {(() => {
            const limitableAccounts = displayAccounts.filter(
              (a) => a.isSelectable || isCustomMode
            )
            if (limitableAccounts.length === 0) return null

            const limitSearchLower = limitSearch.toLowerCase()
            const limitTypes = Array.from(
              new Set(limitableAccounts.map((a) => a.type).filter(Boolean) as string[])
            ).sort()

            const filteredLimitAccounts = limitableAccounts.filter((account) => {
              if (limitOnlyConfigured && account.limitAmount == null) return false
              if (limitTypeFilter !== "all" && account.type !== limitTypeFilter) {
                return false
              }
              if (limitSearchLower === "") return true
              return (
                account.code.toLowerCase().includes(limitSearchLower) ||
                account.name.toLowerCase().includes(limitSearchLower)
              )
            })

            const configuredCount = limitableAccounts.filter(
              (a) => a.limitAmount != null
            ).length

            return (
              <Card>
                <CardHeader>
                  <CardTitle>Spend limits</CardTitle>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Cap the total claimable amount per account. Leave amount blank to
                    remove a limit. {configuredCount} of {limitableAccounts.length}{" "}
                    accounts have a limit configured.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Search / filter / show-all toggle */}
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="relative flex-1 min-w-[200px]">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          placeholder="Search by code or name…"
                          value={limitSearch}
                          onChange={(e) => setLimitSearch(e.target.value)}
                          className="pl-9"
                        />
                      </div>
                      <Button
                        type="button"
                        variant={limitOnlyConfigured ? "default" : "ghost"}
                        className="rounded-full"
                        onClick={() => setLimitOnlyConfigured((v) => !v)}
                      >
                        {limitOnlyConfigured ? "With limit only" : "All accounts"}
                      </Button>
                    </div>

                    {limitTypes.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant={limitTypeFilter === "all" ? "default" : "ghost"}
                          className="rounded-full"
                          onClick={() => setLimitTypeFilter("all")}
                        >
                          All
                        </Button>
                        {limitTypes.map((type) => (
                          <Button
                            key={type}
                            type="button"
                            variant={limitTypeFilter === type ? "default" : "ghost"}
                            className="rounded-full"
                            onClick={() => setLimitTypeFilter(type)}
                          >
                            {type.charAt(0) + type.slice(1).toLowerCase()}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {filteredLimitAccounts.length === 0 ? (
                    <div className="rounded-[20px] bg-surface-low p-5 text-sm leading-6 text-muted-foreground">
                      {limitOnlyConfigured
                        ? "No accounts have a limit configured. Switch to \"All accounts\" to add one."
                        : "No accounts match your search."}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {filteredLimitAccounts.map((account) => (
                        <div
                          key={account.id}
                          className="rounded-[20px] border border-border/70 bg-surface-low p-4 space-y-3"
                        >
                          <div>
                            <p className="font-bold text-foreground">
                              {account.code} · {account.name}
                            </p>
                            {account.limitAmount != null ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Current limit: {account.limitAmount.toFixed(2)} ·{" "}
                                {account.limitPeriod === "PER_CLAIM"
                                  ? "per claim"
                                  : account.limitPeriod === "MONTHLY"
                                    ? "monthly"
                                    : "yearly"}{" "}
                                ·{" "}
                                {account.limitScope === "ORG_WIDE"
                                  ? "org-wide"
                                  : "per employee"}
                              </p>
                            ) : (
                              <p className="mt-1 text-xs text-muted-foreground">No limit configured</p>
                            )}
                          </div>

                          {/* Save form — sets a limit or updates an existing one. */}
                          <form action={limitAction} className="space-y-3">
                            <input type="hidden" name="chartOfAccountId" value={account.id} />
                            <div className="grid gap-3 sm:grid-cols-3">
                              <Input
                                name="limitAmount"
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="Amount"
                                defaultValue={account.limitAmount?.toFixed(2) ?? ""}
                              />
                              <Select
                                name="limitPeriod"
                                defaultValue={account.limitPeriod ?? ""}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Period" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="PER_CLAIM">Per claim</SelectItem>
                                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                                  <SelectItem value="YEARLY">Yearly</SelectItem>
                                </SelectContent>
                              </Select>
                              <Select
                                name="limitScope"
                                defaultValue={account.limitScope ?? ""}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Scope" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="PER_EMPLOYEE">Per employee</SelectItem>
                                  <SelectItem value="ORG_WIDE">Org-wide</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <Button
                              type="submit"
                              variant="outline"
                              className="rounded-xl"
                              disabled={limitPending}
                            >
                              Save limit
                            </Button>
                          </form>

                          {/* Remove form — separate form so it submits empty
                              limit fields regardless of what's typed in the
                              save form above. The action interprets all-empty
                              as "clear" and nulls limitAmount/Period/Scope. */}
                          {account.limitAmount != null ? (
                            <form action={limitAction}>
                              <input type="hidden" name="chartOfAccountId" value={account.id} />
                              <input type="hidden" name="limitAmount" value="" />
                              <input type="hidden" name="limitPeriod" value="" />
                              <input type="hidden" name="limitScope" value="" />
                              <Button
                                type="submit"
                                variant="ghost"
                                size="sm"
                                className="rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive"
                                disabled={limitPending}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Remove limit
                              </Button>
                            </form>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })()}
        </div>
      ) : null}

      {activeTab === "accounts" && accountsSubTab === "mileage" ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Mileage defaults</CardTitle>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Set the organization-wide mileage rate and unit. Per-account
                overrides below take precedence when set.
              </p>
            </CardHeader>
            <CardContent>
              <form
                action={mileageDefaultsAction}
                className="grid gap-3 sm:grid-cols-[1fr_160px_auto]"
              >
                <div className="space-y-1">
                  <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Default rate (per unit)
                  </label>
                  <Input
                    name="defaultMileageRate"
                    type="number"
                    step="0.0001"
                    min="0"
                    placeholder="e.g. 0.60"
                    defaultValue={
                      organization?.defaultMileageRate?.toString() ?? ""
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Unit
                  </label>
                  <Select
                    name="mileageUnit"
                    defaultValue={organization?.mileageUnit ?? "KM"}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="KM">km</SelectItem>
                      <SelectItem value="MILE">mile</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <Button
                    type="submit"
                    className="rounded-xl"
                    disabled={mileageDefaultsPending}
                  >
                    {mileageDefaultsPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Saving…
                      </>
                    ) : (
                      "Save defaults"
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {(() => {
            const mileageSearchLower = mileageSearch.toLowerCase()
            const mileageTypes = Array.from(
              new Set(displayAccounts.map((a) => a.type).filter(Boolean) as string[])
            ).sort()
            const enabledCount = displayAccounts.filter(
              (a) => a.allowMileageClaim
            ).length

            // Single form submits all ticked accounts at once, so hidden rows
            // must stay in the DOM (with `hidden` class) — otherwise filtering
            // them out would silently un-tick their checkboxes on save.
            const isVisible = (account: ChartOfAccountOption): boolean => {
              if (mileageOnlyEnabled && !account.allowMileageClaim) return false
              if (mileageTypeFilter !== "all" && account.type !== mileageTypeFilter)
                return false
              if (mileageSearchLower === "") return true
              return (
                account.code.toLowerCase().includes(mileageSearchLower) ||
                account.name.toLowerCase().includes(mileageSearchLower)
              )
            }

            const visibleCount = displayAccounts.filter(isVisible).length

            return (
              <Card>
                <CardHeader>
                  <CardTitle>Mileage-eligible accounts</CardTitle>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Tick the accounts that should appear when an employee creates a
                    Mileage claim. You can also override the rate per account — leave
                    blank to use the organization default. {enabledCount} of{" "}
                    {displayAccounts.length} accounts enabled for mileage.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {displayAccounts.length === 0 ? (
                    <div className="rounded-[24px] bg-surface-low p-5 text-sm leading-6 text-muted-foreground">
                      Add or sync accounts first from the Claim accounts tab.
                    </div>
                  ) : (
                    <form action={mileageAccountsAction} className="space-y-4">
                      <input
                        type="hidden"
                        name="connectionId"
                        value={activeXeroConnectionId ?? ""}
                      />

                      {/* Search / filter controls */}
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="relative flex-1 min-w-[200px]">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                              placeholder="Search by code or name…"
                              value={mileageSearch}
                              onChange={(e) => setMileageSearch(e.target.value)}
                              className="pl-9"
                            />
                          </div>
                          <Button
                            type="button"
                            variant={mileageOnlyEnabled ? "default" : "ghost"}
                            className="rounded-full"
                            onClick={() => setMileageOnlyEnabled((v) => !v)}
                          >
                            {mileageOnlyEnabled ? "Enabled only" : "All accounts"}
                          </Button>
                        </div>

                        {mileageTypes.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              variant={mileageTypeFilter === "all" ? "default" : "ghost"}
                              className="rounded-full"
                              onClick={() => setMileageTypeFilter("all")}
                            >
                              All
                            </Button>
                            {mileageTypes.map((type) => (
                              <Button
                                key={type}
                                type="button"
                                variant={mileageTypeFilter === type ? "default" : "ghost"}
                                className="rounded-full"
                                onClick={() => setMileageTypeFilter(type)}
                              >
                                {type.charAt(0) + type.slice(1).toLowerCase()}
                              </Button>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      {visibleCount === 0 ? (
                        <div className="rounded-[20px] bg-surface-low p-5 text-sm leading-6 text-muted-foreground">
                          {mileageOnlyEnabled
                            ? "No accounts enabled for mileage yet. Switch to \"All accounts\" to start ticking."
                            : "No accounts match your search."}
                        </div>
                      ) : null}

                      <div className="space-y-3">
                        {displayAccounts.map((account) => {
                          const visible = isVisible(account)
                          return (
                            <label
                              key={account.id}
                              className={cn(
                                "flex items-start gap-3 rounded-[20px] border border-border/70 bg-surface-low p-4 cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5",
                                !visible ? "hidden" : ""
                              )}
                            >
                              <input
                                type="checkbox"
                                name="mileageAccountIds"
                                value={account.id}
                                defaultChecked={account.allowMileageClaim}
                                className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                              />
                              <div className="flex-1 space-y-2">
                                <div>
                                  <p className="font-bold text-foreground">
                                    {account.code} · {account.name}
                                  </p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {account.allowMileageClaim
                                      ? account.mileageRate != null
                                        ? `Override: ${account.mileageRate} per ${
                                            organization?.mileageUnit === "MILE" ? "mile" : "km"
                                          }`
                                        : "Uses org default rate"
                                      : "Not enabled for mileage"}
                                  </p>
                                </div>
                                <div className="max-w-[200px]">
                                  <Input
                                    name={`mileageRate__${account.id}`}
                                    type="number"
                                    step="0.0001"
                                    min="0"
                                    placeholder="Rate override (optional)"
                                    defaultValue={account.mileageRate?.toString() ?? ""}
                                  />
                                </div>
                              </div>
                            </label>
                          )
                        })}
                      </div>

                      <Button
                        type="submit"
                        className="rounded-xl"
                        disabled={mileageAccountsPending}
                      >
                        {mileageAccountsPending ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Saving…
                          </>
                        ) : (
                          "Save mileage accounts"
                        )}
                      </Button>
                    </form>
                  )}
                </CardContent>
              </Card>
            )
          })()}
        </div>
      ) : null}

      {activeTab === "accounts" && accountsSubTab === "banks" ? (() => {
        const bankAccounts = isCustomMode
          ? customAccounts.filter((a) => a.type === "BANK")
          : chartAccounts.filter((a) => a.type === "BANK")
        return (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Bank accounts</CardTitle>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {isCustomMode
                    ? "Mark which custom BANK accounts employees can use for reimbursements."
                    : "Select which Xero bank accounts employees can use for reimbursements. Accounts are scoped to the active Xero connection."}
                </p>
              </CardHeader>
              <CardContent className="space-y-4">

                {isCustomMode ? (
                  bankAccounts.length === 0 ? (
                    <div className="rounded-[24px] bg-surface-low p-5 text-sm leading-6 text-muted-foreground">
                      No custom BANK accounts yet. Add one from the Claim accounts tab using type <span className="font-semibold text-foreground">BANK</span>, then select it here.
                    </div>
                  ) : (
                    <form action={selectedBankAction} className="space-y-4">
                      <div className="grid gap-3 md:grid-cols-2">
                        {bankAccounts.map((account) => (
                          <label
                            key={account.id}
                            className="flex items-start gap-3 rounded-[20px] border border-border/70 bg-surface-low p-4 cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                          >
                            <input
                              type="checkbox"
                              name="bankAccountIds"
                              value={account.id}
                              defaultChecked={account.isBankAccount}
                              className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                            />
                            <div>
                              <p className="font-bold text-foreground">
                                {account.code} · {account.name}
                              </p>
                              <p className="mt-1 text-sm text-muted-foreground">
                                Custom BANK account
                              </p>
                            </div>
                          </label>
                        ))}
                      </div>

                      {selectedBankState.status === "error" ? (
                        <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
                          {selectedBankState.message}
                        </p>
                      ) : null}

                      <Button type="submit" className="rounded-xl" disabled={selectedBankPending}>
                        {selectedBankPending ? (
                          <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
                        ) : (
                          "Save bank accounts"
                        )}
                      </Button>
                    </form>
                  )
                ) : bankAccounts.length === 0 ? (
                  <div className="rounded-[24px] bg-surface-low p-5 text-sm leading-6 text-muted-foreground">
                    No bank accounts found for this Xero connection. Sync your chart of accounts first from the Claim accounts tab.
                  </div>
                ) : (
                  <form action={selectedBankAction} className="space-y-4">
                    <input type="hidden" name="connectionId" value={activeXeroConnectionId ?? ""} />
                    <div className="grid gap-3 md:grid-cols-2">
                      {bankAccounts.map((account) => (
                        <label
                          key={account.id}
                          className="flex items-start gap-3 rounded-[20px] border border-border/70 bg-surface-low p-4 cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                        >
                          <input
                            type="checkbox"
                            name="bankAccountIds"
                            value={account.id}
                            defaultChecked={account.isBankAccount}
                            className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                          />
                          <div>
                            <p className="font-bold text-foreground">
                              {account.code} · {account.name}
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {[account.type, account.status].filter(Boolean).join(" · ") || "Bank account"}
                            </p>
                          </div>
                        </label>
                      ))}
                    </div>

                    {selectedBankState.status === "error" ? (
                      <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
                        {selectedBankState.message}
                      </p>
                    ) : null}

                    <Button type="submit" className="rounded-xl" disabled={selectedBankPending}>
                      {selectedBankPending ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
                      ) : (
                        "Save bank accounts"
                      )}
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>
          </div>
        )
      })() : null}

      {activeTab === "projects" ? (
        <div className="space-y-6">
          <OrgGeofenceRadiusCard
            initial={organization?.geofenceRadiusMeters ?? 200}
          />
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>
                  {isCustomMode ? "Projects" : `Xero projects — ${activeConnection?.tenantName ?? "Xero"}`}
                </CardTitle>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {isCustomMode
                    ? "Create and manage projects. Assign a project manager and location to each."
                    : "Sync projects from Xero. You can assign a project manager and location to each."}
                </p>
              </div>
              {!isCustomMode && activeXeroConnectionId ? (
                <form action={projectsAction}>
                  <input type="hidden" name="connectionId" value={activeXeroConnectionId} />
                  <Button type="submit" variant="outline" className="rounded-xl" disabled={projectsPending}>
                    {projectsPending ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Syncing…</>
                    ) : (
                      "Sync Xero projects"
                    )}
                  </Button>
                </form>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Manual project creation — only when no Xero connected */}
              {isCustomMode ? (
                <form action={createProjectAction} className="space-y-3">
                  <p className="text-sm font-semibold text-muted-foreground">Add project</p>
                  <div className="flex flex-wrap gap-3">
                    <Input
                      name="name"
                      placeholder="Project name"
                      className="flex-1 min-w-[180px]"
                      required
                    />
                    <div className="min-w-[200px] flex-1">
                      {/* Pick one PM at creation time. More can be added
                          later by editing the project — that's where the
                          full multi-select PM picker lives. The form
                          field is named `projectManagerIds` so the action
                          reads it as a list (with one entry). */}
                      <Select name="projectManagerIds" defaultValue="__none">
                        <SelectTrigger className="text-sm">
                          <SelectValue placeholder="No project manager" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">No project manager</SelectItem>
                          {members
                            .filter((m) => m.role === "SUPERVISOR")
                            .map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <CoordinatePairInputs className="w-full" />
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    className="rounded-xl"
                    disabled={createProjectPending}
                  >
                    {createProjectPending ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Adding…</>
                    ) : (
                      <><Plus className="mr-2 h-4 w-4" />Add project</>
                    )}
                  </Button>
                </form>
              ) : null}

              {projects.length === 0 ? (
                <div className="rounded-[24px] bg-surface-low p-5 text-sm leading-6 text-muted-foreground">
                  {isCustomMode
                    ? "No projects yet. Add one above."
                    : "No Xero projects imported yet. Use the Sync button."}
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search projects…"
                      value={projectSearch}
                      onChange={(e) => setProjectSearch(e.target.value)}
                      className="pl-9"
                    />
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    {projects
                      .filter((p) =>
                        projectSearchLower === "" ||
                        p.name.toLowerCase().includes(projectSearchLower)
                      )
                      .map((project) => (
                        <ProjectCard
                          key={project.id}
                          project={project}
                          members={members}
                          onUpdate={handleUpdateProject}
                          onDelete={project.isManual ? handleDeleteProject : undefined}
                        />
                      ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {activeTab === "work-schedule" ? (
        <div className="space-y-6">
          <nav className="flex flex-wrap gap-2">
            {(
              [
                ["ot-rates", "OT Rates"],
                ["calendar", "Calendar"],
              ] as const
            ).map(([value, label]) => (
              <Link
                key={value}
                href={`/admin/settings?tab=work-schedule&section=${value}`}
                onClick={() => setWorkScheduleSection(value)}
                className={cn(
                  "rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors",
                  workScheduleSection === value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/60 bg-card text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </Link>
            ))}
          </nav>

          {workScheduleSection === "ot-rates" ? (
            <>
              <OrgOtToggleCard organization={organization} />
              <OtRatesCard organization={organization} />
            </>
          ) : (
            <>
              <OrgWorkingHoursCard initial={workingHours} />
              <OrgTimezoneCard initial={timezone} />
              <ProjectCalendarPanel projects={projects} orgWorkingHours={workingHours} />
            </>
          )}
        </div>
      ) : null}

      {activeTab === "leave" ? (
        <ComingSoonCard
          title="Leave"
          body="Leave applications and balances will live here. Coming as a separate module."
        />
      ) : null}
    </div>
  )
}

function OtRatesCard({ organization }: { organization?: OrganizationSummary }) {
  const rates = organization?.otRates ?? {
    normalDay: 1.5,
    restDay: 2.0,
    publicHoliday: 3.0,
    restDayInShift: 1.0,
    publicHolidayInShift: 2.0,
    salaryThreshold: 4000,
    dailyThresholdMinutes: 480,
  }
  const dailyThresholdHours =
    Math.round((rates.dailyThresholdMinutes / 60) * 100) / 100

  const [state, formAction, pending] = useActionState(
    saveOtRatesAction,
    initialSettingsActionState
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overtime rates</CardTitle>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Multipliers used when computing overtime pay. ORP = monthly salary ÷ 26.
          HRP = ORP ÷ 8. Defaults follow the Malaysian Employment Act.
        </p>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-6">
          <div>
            <p className="text-sm font-semibold text-foreground">Daily OT threshold</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Time worked beyond this many hours per day counts as overtime
              (after approval). Applies to all employees.
            </p>
            <div className="mt-3 max-w-xs">
              <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                <span>Threshold (hours/day)</span>
                <Input
                  name="otDailyThresholdHours"
                  type="number"
                  step="0.25"
                  min="0"
                  max="24"
                  defaultValue={dailyThresholdHours}
                  disabled={pending}
                />
              </label>
            </div>
          </div>

          <div>
            <p className="text-sm font-semibold text-foreground">Overtime multiplier</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Applied to HRP for hours worked beyond the regular shift (after 8 hours
              for monthly-paid; after 8 total for daily-paid).
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <RateInput
                name="otRateNormalDay"
                label="Normal day (Mon–Sat)"
                suffix="× HRP"
                defaultValue={rates.normalDay}
                disabled={pending}
              />
              <RateInput
                name="otRateRestDay"
                label="Rest day (Sun)"
                suffix="× HRP"
                defaultValue={rates.restDay}
                disabled={pending}
              />
              <RateInput
                name="otRatePublicHoliday"
                label="Public holiday"
                suffix="× HRP"
                defaultValue={rates.publicHoliday}
                disabled={pending}
              />
            </div>
          </div>

          <div>
            <p className="text-sm font-semibold text-foreground">Special-day premium</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Applied to ORP for hours worked within the regular shift on rest days
              or public holidays.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <RateInput
                name="restDayInShiftRate"
                label="Rest day work"
                suffix="× ORP"
                defaultValue={rates.restDayInShift}
                disabled={pending}
              />
              <RateInput
                name="publicHolidayInShiftRate"
                label="Public holiday work"
                suffix="× ORP"
                defaultValue={rates.publicHolidayInShift}
                disabled={pending}
              />
            </div>
          </div>

          <div>
            <p className="text-sm font-semibold text-foreground">OT eligibility</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              For staff above this monthly salary cap (basic + fixed allowance), OT
              requires management approval and is limited to operational/technical roles.
            </p>
            <div className="mt-3 max-w-xs">
              <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                <span>Salary threshold (RM)</span>
                <Input
                  name="otSalaryThreshold"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={rates.salaryThreshold}
                  disabled={pending}
                />
              </label>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-sm">
              {state.status === "error" ? (
                <span className="font-semibold text-destructive">{state.message}</span>
              ) : state.status === "success" ? (
                <span className="font-semibold text-success">{state.message}</span>
              ) : null}
            </div>
            <Button type="submit" className="rounded-xl" disabled={pending}>
              {pending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save OT rates"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function RateInput({
  name,
  label,
  suffix,
  defaultValue,
  disabled,
}: {
  name: string
  label: string
  suffix: string
  defaultValue: number
  disabled?: boolean
}) {
  return (
    <label className="space-y-2 text-sm font-semibold text-muted-foreground">
      <span>{label}</span>
      <div className="relative">
        <Input
          name={name}
          type="number"
          step="0.1"
          min="1"
          max="10"
          defaultValue={defaultValue}
          disabled={disabled}
          className="pr-16"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">
          {suffix}
        </span>
      </div>
    </label>
  )
}

function OrgWorkingHoursCard({ initial }: { initial: { start: string; end: string } }) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [start, setStart] = useState(initial.start)
  const [end, setEnd] = useState(initial.end)

  function handleSave() {
    startTransition(async () => {
      const result = await saveOrgWorkingHoursAction(start, end)
      toast({ title: result.message, variant: result.ok ? "success" : "error" })
    })
  }

  const dirty = start !== initial.start || end !== initial.end

  return (
    <Card>
      <CardHeader>
        <CardTitle>Org default hours</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Used by any project that doesn&apos;t set its own hours.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-[8rem_8rem_1fr] sm:items-end">
          <TimeField
            label="Start"
            value={start}
            onChange={(v) => setStart(v || initial.start)}
            disabled={pending}
          />
          <TimeField
            label="End"
            value={end}
            onChange={(v) => setEnd(v || initial.end)}
            disabled={pending}
          />
          <div className="flex items-center justify-end">
            <Button
              type="button"
              size="sm"
              className="rounded-lg"
              onClick={handleSave}
              disabled={pending || !dirty}
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function OrgTimezoneCard({ initial }: { initial: string }) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [tz, setTz] = useState(initial)
  const dirty = tz !== initial

  function handleSave() {
    startTransition(async () => {
      const result = await saveOrgTimezoneAction(tz)
      toast({ title: result.message, variant: result.ok ? "success" : "error" })
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timezone</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Drives the local time shown on attendance approvals and the
          comparison used to detect late / early clock-ins.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-[18rem_1fr] sm:items-end">
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              IANA timezone
            </label>
            <div className="mt-1">
              <Select value={tz} onValueChange={setTz} disabled={pending}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-end">
            <Button
              type="button"
              size="sm"
              className="rounded-lg"
              onClick={handleSave}
              disabled={pending || !dirty}
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function OrgGeofenceRadiusCard({ initial }: { initial: number }) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [meters, setMeters] = useState(String(initial))

  function handleSave() {
    const value = parseInt(meters, 10)
    startTransition(async () => {
      const result = await saveGeofenceRadiusAction(value)
      toast({ title: result.message, variant: result.ok ? "success" : "error" })
    })
  }

  const dirty = String(initial) !== meters && /^\d+$/.test(meters)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Geofence radius</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Maximum distance (in metres) an employee can be from a project&apos;s
          coordinates while still counting as on-site for clock-in. Anyone
          outside the radius can still clock in but must add a remark.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr] sm:items-end">
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Metres
            </label>
            <div className="mt-1 flex items-center gap-2">
              <Input
                type="number"
                inputMode="numeric"
                min={10}
                max={10000}
                step={10}
                value={meters}
                onChange={(e) => setMeters(e.target.value)}
                disabled={pending}
                className="h-9 text-sm"
              />
              <span className="text-xs font-semibold text-muted-foreground">m</span>
            </div>
          </div>
          <div className="flex items-center justify-end">
            <Button
              type="button"
              size="sm"
              className="rounded-lg"
              onClick={handleSave}
              disabled={pending || !dirty}
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function OrgOtToggleCard({ organization }: { organization?: OrganizationSummary }) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [enabled, setEnabled] = useState<boolean>(organization?.otEnabled ?? true)

  useEffect(() => {
    setEnabled(organization?.otEnabled ?? true)
  }, [organization?.otEnabled])

  function handleToggle(next: boolean) {
    setEnabled(next)
    startTransition(async () => {
      const result = await toggleOrgOtAction(next)
      if (!result.ok) {
        setEnabled(!next)
        toast({ title: result.message, variant: "error" })
      } else {
        toast({ title: result.message, variant: "success" })
      }
    })
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-5">
        <div>
          <p className="text-sm font-semibold text-foreground">Overtime feature</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            When off, overtime is not accrued or paid for any project in this organization.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={pending}
          onClick={() => handleToggle(!enabled)}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
            enabled ? "bg-primary" : "bg-border",
            pending && "opacity-60"
          )}
        >
          <span
            className={cn(
              "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
              enabled ? "translate-x-5" : "translate-x-0.5"
            )}
          />
        </button>
      </CardContent>
    </Card>
  )
}

const WEEKDAYS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
]

function parseWorkingDays(csv: string | null | undefined): Set<number> {
  if (!csv) return new Set([1, 2, 3, 4, 5])
  return new Set(
    csv
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
  )
}

function ProjectCalendarPanel({
  projects,
  orgWorkingHours,
}: {
  projects: OrganizationProjectOption[]
  orgWorkingHours: { start: string; end: string }
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialId = searchParams.get("projectId") ?? projects[0]?.id ?? ""
  const [selectedId, setSelectedId] = useState<string>(initialId)

  useEffect(() => {
    const fromUrl = searchParams.get("projectId")
    if (fromUrl && fromUrl !== selectedId) setSelectedId(fromUrl)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const project = projects.find((p) => p.id === selectedId) ?? projects[0]

  function handlePick(id: string) {
    setSelectedId(id)
    const params = new URLSearchParams(searchParams.toString())
    params.set("tab", "work-schedule")
    params.set("section", "calendar")
    params.set("projectId", id)
    router.replace(`/admin/settings?${params.toString()}`)
  }

  if (projects.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Calendar</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Add a project first to configure its calendar.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Project</CardTitle>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Each project keeps its own working hours, working days and holidays.
          </p>
        </CardHeader>
        <CardContent>
          <Select value={selectedId} onValueChange={handlePick}>
            <SelectTrigger className="h-10 text-sm">
              <SelectValue placeholder="Pick a project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {project ? (
        <>
          <ProjectWorkingHoursCard
            project={project}
            orgWorkingHours={orgWorkingHours}
          />
          <ProjectHolidaysCard project={project} />
          <ProjectCalendarView project={project} />
        </>
      ) : null}
    </div>
  )
}

function TimeField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const display = value || placeholder || "--:--"

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      const target = e.target as Node
      if (wrapRef.current?.contains(target)) return
      if (popRef.current?.contains(target)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative block">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          "mt-1 flex w-full items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-left transition-colors",
          open
            ? "border-primary ring-1 ring-primary/30"
            : "border-border hover:border-border/80",
          disabled && "opacity-60"
        )}
      >
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <span
          className={cn(
            "flex-1 text-sm font-semibold tabular-nums",
            value ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {display}
        </span>
        {value ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onChange("")
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                e.stopPropagation()
                onChange("")
              }
            }}
            className="text-[10px] font-semibold text-muted-foreground hover:text-foreground"
            aria-label={`Clear ${label}`}
          >
            ✕
          </span>
        ) : null}
      </button>

      {open ? (
        <TimePopover
          anchorRef={wrapRef}
          popoverRef={popRef}
          value={value}
          onSelect={(next) => {
            onChange(next)
            setOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

function TimePopover({
  anchorRef,
  popoverRef,
  value,
  onSelect,
}: {
  anchorRef: React.RefObject<HTMLDivElement | null>
  popoverRef: React.RefObject<HTMLDivElement | null>
  value: string
  onSelect: (next: string) => void
}) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    function update() {
      const el = anchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setPos({
        top: r.bottom + window.scrollY + 8,
        left: r.left + window.scrollX,
        width: r.width,
      })
    }
    update()
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [anchorRef])

  const initialHour = value ? Number(value.slice(0, 2)) : 9
  const initialMinute = value ? Number(value.slice(3, 5)) : 0
  const [h, setH] = useState<number>(Number.isFinite(initialHour) ? initialHour : 9)
  const [m, setM] = useState<number>(Number.isFinite(initialMinute) ? initialMinute : 0)

  const hours = Array.from({ length: 24 }, (_, i) => i)
  const minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]

  const formatted = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`

  if (typeof document === "undefined" || !pos) return null

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: "absolute",
        top: pos.top,
        left: pos.left,
        zIndex: 9999,
      }}
      className="w-44 rounded-lg border border-border bg-card p-2 shadow-md"
    >
      <div className="grid grid-cols-2 gap-1.5">
        <div className="h-32 overflow-y-auto rounded border border-border/40 [scrollbar-width:thin]">
          {hours.map((hh) => (
            <button
              key={hh}
              type="button"
              onClick={() => setH(hh)}
              className={cn(
                "block w-full px-2 py-1 text-center text-xs tabular-nums transition-colors",
                hh === h
                  ? "bg-foreground/5 font-semibold text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {String(hh).padStart(2, "0")}
            </button>
          ))}
        </div>
        <div className="h-32 overflow-y-auto rounded border border-border/40 [scrollbar-width:thin]">
          {minutes.map((mm) => (
            <button
              key={mm}
              type="button"
              onClick={() => setM(mm)}
              className={cn(
                "block w-full px-2 py-1 text-center text-xs tabular-nums transition-colors",
                mm === m
                  ? "bg-foreground/5 font-semibold text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {String(mm).padStart(2, "0")}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onSelect(formatted)}
        className="mt-2 w-full rounded border border-border/60 py-1 text-xs font-semibold tabular-nums text-foreground hover:bg-foreground/5"
      >
        {formatted}
      </button>
    </div>,
    document.body
  )
}

function ProjectCalendarView({ project }: { project: OrganizationProjectOption }) {
  const today = new Date()
  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())

  const workingDays = parseWorkingDays(project.workingDays)
  const holidayMap = new Map(
    (project.holidays ?? []).map((h) => [h.date, h.name] as const)
  )

  const firstOfMonth = new Date(viewYear, viewMonth, 1)
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
  // Calendar grid starts on Monday (ISO 1..7)
  const firstWeekdayIso = ((firstOfMonth.getDay() + 6) % 7) + 1
  const leadingBlanks = firstWeekdayIso - 1

  const cells: Array<{ day: number; iso: string; weekday: number } | null> = []
  for (let i = 0; i < leadingBlanks; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(viewYear, viewMonth, d)
    const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    const weekday = ((date.getDay() + 6) % 7) + 1
    cells.push({ day: d, iso, weekday })
  }
  while (cells.length % 7 !== 0) cells.push(null)

  function shift(delta: number) {
    const next = new Date(viewYear, viewMonth + delta, 1)
    setViewYear(next.getFullYear())
    setViewMonth(next.getMonth())
  }

  const monthLabel = firstOfMonth.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold tabular-nums">{monthLabel}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => shift(-1)}
              className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
              aria-label="Previous month"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => shift(1)}
              className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground"
              aria-label="Next month"
            >
              ›
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-1 grid grid-cols-7 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {WEEKDAYS.map((d) => (
            <div key={d.value} className="py-1">{d.label.charAt(0)}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px rounded-md bg-border/40 overflow-hidden">
          {cells.map((cell, idx) => {
            if (!cell) {
              return <div key={`blank-${idx}`} className="min-h-[60px] bg-card" />
            }
            const isWorking = workingDays.has(cell.weekday)
            const holidayName = holidayMap.get(cell.iso)
            const isHoliday = !!holidayName
            const isToday =
              cell.iso ===
              `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`

            return (
              <div
                key={cell.iso}
                className={cn(
                  "min-h-[60px] p-1.5 transition-colors",
                  isHoliday
                    ? "bg-primary/5"
                    : isWorking
                      ? "bg-card"
                      : "bg-surface-low"
                )}
                title={holidayName ?? undefined}
              >
                <span
                  className={cn(
                    "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] tabular-nums",
                    isToday
                      ? "bg-primary text-primary-foreground font-bold"
                      : isHoliday
                        ? "text-primary font-semibold"
                        : isWorking
                          ? "text-foreground"
                          : "text-muted-foreground/60"
                  )}
                >
                  {cell.day}
                </span>
                {isHoliday ? (
                  <p className="mt-0.5 line-clamp-2 text-[10px] font-medium leading-tight text-primary/80">
                    {holidayName}
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-card border border-border/60" />
            Working day
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-surface-low border border-border/60" />
            Rest / off
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-primary/10 border border-primary/20" />
            Public holiday
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-primary" />
            Today
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function ProjectWorkingHoursCard({
  project,
  orgWorkingHours,
}: {
  project: OrganizationProjectOption
  orgWorkingHours: { start: string; end: string }
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [start, setStart] = useState(project.workingHoursStart ?? "")
  const [end, setEnd] = useState(project.workingHoursEnd ?? "")
  const [days, setDays] = useState<Set<number>>(parseWorkingDays(project.workingDays))

  useEffect(() => {
    setStart(project.workingHoursStart ?? "")
    setEnd(project.workingHoursEnd ?? "")
    setDays(parseWorkingDays(project.workingDays))
  }, [project.id, project.workingHoursStart, project.workingHoursEnd, project.workingDays])

  function toggleDay(value: number) {
    setDays((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  function handleSave() {
    startTransition(async () => {
      const result = await saveProjectCalendarAction(project.id, {
        workingHoursStart: start.trim() || null,
        workingHoursEnd: end.trim() || null,
        workingDays: days.size === 0 ? null : Array.from(days).sort().join(","),
      })
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
    })
  }

  function resetToOrgDefault() {
    setStart("")
    setEnd("")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Working hours &amp; days</CardTitle>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Leave hours blank to inherit the organization default
          ({orgWorkingHours.start}–{orgWorkingHours.end}).
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[8rem_8rem_1fr] sm:items-end">
          <TimeField
            label="Start"
            value={start}
            onChange={setStart}
            placeholder={orgWorkingHours.start}
            disabled={pending}
          />
          <TimeField
            label="End"
            value={end}
            onChange={setEnd}
            placeholder={orgWorkingHours.end}
            disabled={pending}
          />
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={resetToOrgDefault}
              disabled={pending || (!start && !end)}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              Use org default
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {start && end
            ? `${start}–${end}`
            : `Using org default ${orgWorkingHours.start}–${orgWorkingHours.end}`}
        </p>

        <div>
          <p className="text-sm font-semibold text-foreground">Working days</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Days the project operates. Days outside this set are treated as rest days.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {WEEKDAYS.map((d) => {
              const active = days.has(d.value)
              return (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => toggleDay(d.value)}
                  disabled={pending}
                  className={cn(
                    "rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border/60 bg-card text-muted-foreground hover:text-foreground"
                  )}
                >
                  {d.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            className="rounded-xl"
            onClick={handleSave}
            disabled={pending}
          >
            {pending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save calendar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ProjectHolidaysCard({ project }: { project: OrganizationProjectOption }) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [date, setDate] = useState("")
  const [name, setName] = useState("")
  const [importYear, setImportYear] = useState<string>(String(new Date().getFullYear()))
  const [importCountry, setImportCountry] = useState<string>("MY")
  const [showList, setShowList] = useState(false)
  const holidays = project.holidays ?? []

  function handleImport() {
    const yearNum = Number(importYear)
    if (!Number.isInteger(yearNum)) {
      toast({ title: "Year must be a whole number.", variant: "error" })
      return
    }
    startTransition(async () => {
      const result = await importProjectHolidaysAction(
        project.id,
        yearNum,
        importCountry.trim().toUpperCase()
      )
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
    })
  }

  function handleAdd() {
    if (!date || !name.trim()) {
      toast({ title: "Date and name are required.", variant: "error" })
      return
    }
    startTransition(async () => {
      const result = await addProjectHolidayAction(project.id, date, name)
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
      if (result.ok) {
        setDate("")
        setName("")
      }
    })
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      const result = await deleteProjectHolidayAction(id)
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Public holidays</CardTitle>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Dates listed here count as public holidays for this project. They influence OT
          rate selection for hours worked on that day.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-2xl border border-border/60 bg-surface-low p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Import from public holiday API
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[6rem_5rem_auto] sm:items-end">
            <label className="space-y-1 text-xs font-semibold text-muted-foreground">
              <span>Year</span>
              <Input
                type="number"
                min="2000"
                max="2100"
                value={importYear}
                onChange={(e) => setImportYear(e.target.value)}
                disabled={pending}
              />
            </label>
            <label className="space-y-1 text-xs font-semibold text-muted-foreground">
              <span>Country</span>
              <Input
                type="text"
                maxLength={2}
                value={importCountry}
                onChange={(e) => setImportCountry(e.target.value.toUpperCase())}
                placeholder="MY"
                disabled={pending}
              />
            </label>
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              onClick={handleImport}
              disabled={pending}
            >
              <Download className="mr-2 h-4 w-4" />Import
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            ISO-3166 country code (MY, SG, US, GB, …). Existing entries on the same date are overwritten.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-end">
          <label className="space-y-2 text-sm font-semibold text-muted-foreground">
            <span>Date</span>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={pending}
            />
          </label>
          <label className="space-y-2 text-sm font-semibold text-muted-foreground">
            <span>Name</span>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Hari Raya"
              disabled={pending}
            />
          </label>
          <Button
            type="button"
            className="rounded-xl"
            onClick={handleAdd}
            disabled={pending}
          >
            <Plus className="mr-2 h-4 w-4" />Add
          </Button>
        </div>

        {holidays.length === 0 ? (
          <p className="text-sm text-muted-foreground">No holidays configured.</p>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setShowList((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              <span>{showList ? "Hide" : "Show"} holiday list ({holidays.length})</span>
              <span className="text-[10px]">{showList ? "▲" : "▼"}</span>
            </button>
            {showList ? (
              <ul className="mt-2 divide-y divide-border/60">
                {holidays.map((h) => (
                  <li
                    key={h.id}
                    className="flex items-center justify-between gap-4 py-2"
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="text-sm font-semibold text-foreground">{h.date}</span>
                      <span className="text-sm text-muted-foreground">{h.name}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDelete(h.id)}
                      disabled={pending}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={`Delete ${h.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------------------------
// Currency settings form
// ----------------------------------------------------------------------------

/**
 * Searchable multi-select for the curated CURRENCY_CATALOG plus a radio
 * for the default. The default radio is constrained to currencies that
 * are also checked in the multi-select, matching the server-side
 * superRefine. State is local; on submit the form posts:
 *   - allowedCurrencies as repeated form fields
 *   - defaultCurrency as a single radio value
 */
function CurrencySettingsForm({
  action,
  pending,
  initialAllowed,
  initialDefault,
}: {
  action: (formData: FormData) => void
  pending: boolean
  initialAllowed: string[]
  initialDefault?: string
}) {
  const [allowed, setAllowed] = useState<string[]>(() => initialAllowed)
  const [defaultCode, setDefaultCode] = useState<string>(
    () => initialDefault ?? initialAllowed[0] ?? "",
  )
  const [search, setSearch] = useState("")

  const filtered = CURRENCY_CATALOG.filter((c) => {
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return (
      c.code.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      c.symbol.toLowerCase().includes(q)
    )
  })

  function toggleCurrency(code: string) {
    setAllowed((prev) => {
      const next = prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
      // If the just-removed code was the default, fall back to the first
      // remaining one (or empty).
      if (!next.includes(defaultCode)) {
        setDefaultCode(next[0] ?? "")
      }
      return next
    })
  }

  return (
    <form action={action} className="space-y-5">
      <div>
        <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Allowed currencies
        </label>
        <p className="mt-1 text-sm text-muted-foreground">
          {allowed.length === 0
            ? "Pick at least one currency to enable claim submission."
            : `${allowed.length} selected — these appear in the employee's currency dropdown.`}
        </p>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search by code, name, or symbol"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="mt-3 max-h-[220px] overflow-y-auto rounded-2xl border border-border/60 bg-surface-low p-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">No matches.</p>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((c) => {
                const checked = allowed.includes(c.code)
                return (
                  <li key={c.code}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-card">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCurrency(c.code)}
                        className="h-4 w-4 accent-primary"
                      />
                      <span className="font-mono text-sm font-semibold tracking-wide">
                        {c.code}
                      </span>
                      <span className="flex-1 text-sm text-muted-foreground">{c.name}</span>
                      <span className="text-sm text-muted-foreground">{c.symbol}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {allowed.map((code) => (
          <input key={code} type="hidden" name="allowedCurrencies" value={code} />
        ))}
      </div>

      <div>
        <label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Default currency
        </label>
        <p className="mt-1 text-sm text-muted-foreground">
          Used when the receipt scanner can&apos;t detect a currency. Must be one of the selected
          codes above.
        </p>
        {allowed.length === 0 ? (
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Select at least one currency above first.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {allowed.map((code) => {
              const opt = CURRENCY_CATALOG.find((c) => c.code === code)
              const checked = defaultCode === code
              return (
                <label
                  key={code}
                  className={
                    "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors " +
                    (checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border/60 bg-card text-foreground hover:bg-surface-low")
                  }
                >
                  <input
                    type="radio"
                    name="defaultCurrency"
                    value={code}
                    checked={checked}
                    onChange={() => setDefaultCode(code)}
                    className="sr-only"
                  />
                  <span className="font-mono font-semibold">{code}</span>
                  {opt ? <span className="opacity-80">{opt.symbol}</span> : null}
                </label>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button
          type="submit"
          className="rounded-xl"
          disabled={pending || allowed.length === 0 || !defaultCode}
        >
          {pending ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
          ) : (
            "Save currencies"
          )}
        </Button>
      </div>
    </form>
  )
}
