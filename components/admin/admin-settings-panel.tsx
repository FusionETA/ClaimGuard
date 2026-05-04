"use client"

import { useActionState, useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { Loader2, MapPin, Plus, Search, Trash2 } from "lucide-react"

import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import {
  createOrganizationAction,
  createCustomAccountAction,
  createManualProjectAction,
  deleteCustomAccountAction,
  deleteManualProjectAction,
  saveClaimRunSettingsAction,
  saveOrganizationSettingsAction,
  saveOtRatesAction,
  saveSelectableAccountsAction,
  saveSelectedBankAccountsAction,
  selectXeroTenantAction,
  switchActiveXeroConnectionAction,
  syncXeroAccountsAction,
  syncXeroProjectsAction,
  updateProjectAction,
} from "@/app/(admin)/admin/settings/actions"
import { setWorkingHoursAction, type SetWorkingHoursState } from "@/app/(admin)/admin/attendance/actions"
import { XeroConnectionCard } from "@/components/admin/xero-connection-card"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import type { XeroTenant } from "@/lib/xero"
import type { AdminProfile } from "@/modules/claims/domain/models"
import type {
  ChartOfAccountOption,
  OrganizationMember,
  OrganizationProjectOption,
  OrganizationSummary,
  XeroConnectionSummary,
} from "@/modules/organization/domain/models"

type TabKey = "organization" | "accounts" | "banks" | "projects" | "runs" | "attendance"

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
    projectManagerId: string | undefined,
    location: string | undefined,
    latitude: number | null,
    longitude: number | null
  ) => void
  onDelete?: (id: string) => void
}) {
  const [pmId, setPmId] = useState(project.projectManagerId ?? "")
  const [coords, setCoords] = useState<{ lat: number | null; lng: number | null }>({
    lat: project.latitude ?? null,
    lng: project.longitude ?? null,
  })
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    // Server derives `location` from coords; pass undefined to let it overwrite.
    await onUpdate(project.id, pmId || undefined, undefined, coords.lat, coords.lng)
    setSaving(false)
  }

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
      <Select
        value={pmId || "__none"}
        onValueChange={(v) => setPmId(v === "__none" ? "" : v)}
      >
        <SelectTrigger className="h-10 text-sm">
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
  initialTab,
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
  initialTab?: string
}) {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<TabKey>((initialTab as TabKey) ?? "organization")

  useEffect(() => {
    if (initialTab && initialTab !== activeTab) {
      setActiveTab(initialTab as TabKey)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab])
  const [accountTypeFilter, setAccountTypeFilter] = useState<string>("all")
  const [accountSearch, setAccountSearch] = useState("")
  const [projectSearch, setProjectSearch] = useState("")
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
  const [createOrganizationState, createOrganizationFormAction, createOrganizationPending] =
    useActionState(createOrganizationAction, initialSettingsActionState)
  const [selectedBankState, selectedBankAction, selectedBankPending] = useActionState(
    saveSelectedBankAccountsAction,
    initialSettingsActionState
  )
  const [createProjectState, createProjectAction, createProjectPending] = useActionState(
    createManualProjectAction,
    initialSettingsActionState
  )

  useEffect(() => {
    if (organizationState.status === "success") toast({ title: organizationState.message, variant: "success" })
    if (organizationState.status === "error") toast({ title: organizationState.message, variant: "error" })
  }, [organizationState.status, organizationState.message, toast])

  useEffect(() => {
    if (accountsState.status === "success") toast({ title: accountsState.message, variant: "success" })
    if (accountsState.status === "error") toast({ title: accountsState.message, variant: "error" })
  }, [accountsState.status, accountsState.message, toast])

  useEffect(() => {
    if (claimRunState.status === "success") toast({ title: claimRunState.message, variant: "success" })
    if (claimRunState.status === "error") toast({ title: claimRunState.message, variant: "error" })
  }, [claimRunState.status, claimRunState.message, toast])

  useEffect(() => {
    if (xeroState.status === "success") toast({ title: xeroState.message, variant: "success" })
    if (xeroState.status === "error") toast({ title: xeroState.message, variant: "error" })
  }, [xeroState.status, xeroState.message, toast])

  useEffect(() => {
    if (projectsState.status === "success") toast({ title: projectsState.message, variant: "success" })
    if (projectsState.status === "error") toast({ title: projectsState.message, variant: "error" })
  }, [projectsState.status, projectsState.message, toast])

  useEffect(() => {
    if (selectTenantState.status === "success") toast({ title: selectTenantState.message, variant: "success" })
    if (selectTenantState.status === "error") toast({ title: selectTenantState.message, variant: "error" })
  }, [selectTenantState.status, selectTenantState.message, toast])

  useEffect(() => {
    if (createAccountState.status === "success") toast({ title: createAccountState.message, variant: "success" })
    if (createAccountState.status === "error") toast({ title: createAccountState.message, variant: "error" })
  }, [createAccountState.status, createAccountState.message, toast])

  useEffect(() => {
    if (createOrganizationState.status === "success") {
      toast({ title: createOrganizationState.message, variant: "success" })
    }
    if (createOrganizationState.status === "error") {
      toast({ title: createOrganizationState.message, variant: "error" })
    }
  }, [createOrganizationState.status, createOrganizationState.message, toast])

  useEffect(() => {
    if (selectedBankState.status === "success") toast({ title: selectedBankState.message, variant: "success" })
    if (selectedBankState.status === "error") toast({ title: selectedBankState.message, variant: "error" })
  }, [selectedBankState.status, selectedBankState.message, toast])

  useEffect(() => {
    if (createProjectState.status === "success") toast({ title: createProjectState.message, variant: "success" })
    if (createProjectState.status === "error") toast({ title: createProjectState.message, variant: "error" })
  }, [createProjectState.status, createProjectState.message, toast])

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
    projectManagerId: string | undefined,
    location: string | undefined,
    latitude: number | null,
    longitude: number | null
  ) {
    const result = await updateProjectAction(projectId, projectManagerId, location, latitude, longitude)
    if (result.ok) {
      toast({ title: result.message, variant: "success" })
    } else {
      toast({ title: result.message, variant: "error" })
    }
  }

  const settingsTabs = [
    ["organization", "Organization"],
    ["accounts", "Claim accounts"],
    ["banks", "Bank accounts"],
    ["projects", "Projects"],
    ["runs", "Claim runs"],
    ["attendance", "Attendance"],
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

              <div className="rounded-[24px] bg-surface-low p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Current admin
                </p>
                <p className="mt-2 text-lg font-black">{admin.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {admin.email}
                  {organization?.name ? ` · ${organization.name}` : ""}
                </p>
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

              <form action={createOrganizationFormAction} className="space-y-4 rounded-[24px] border border-dashed border-border/70 p-5">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">Add another company</p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Create a separate company workspace. You can switch companies from the dropdown in the header.
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Input
                    name="name"
                    disabled={createOrganizationPending}
                    className="min-w-[220px] flex-1"
                  />
                  <Button type="submit" variant="outline" className="rounded-xl" disabled={createOrganizationPending}>
                    {createOrganizationPending ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating…</>
                    ) : (
                      <><Plus className="mr-2 h-4 w-4" />Add company</>
                    )}
                  </Button>
                </div>
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

        </div>
      ) : null}

      {activeTab === "accounts" ? (
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
        </div>
      ) : null}

      {activeTab === "banks" ? (() => {
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
                      <Select name="projectManagerId" defaultValue="__none">
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

      {activeTab === "runs" ? (
        <Card>
          <CardHeader>
            <CardTitle>Claims run cutoff</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              Claims submitted on or before this day stay in the current month&apos;s claims run.
              Claims submitted after this cutoff are still accepted, but they move to the next run.
            </p>

            <form action={claimRunAction} className="space-y-4">
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
                Save claim run settings
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {activeTab === "attendance" ? (
        <div className="space-y-6">
          <WorkingHoursCard initial={workingHours} />
          <OtRatesCard organization={organization} />
        </div>
      ) : null}
    </div>
  )
}

function WorkingHoursCard({ initial }: { initial: { start: string; end: string } }) {
  const [state, formAction, pending] = useActionState<SetWorkingHoursState, FormData>(
    setWorkingHoursAction,
    {}
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Working hours</CardTitle>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          The standard daily start and end time used to flag late check-ins and missing
          attendance for everyone in this organization.
        </p>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="space-y-2 text-sm font-semibold text-muted-foreground">
            <span>Start</span>
            <Input
              name="start"
              type="time"
              defaultValue={initial.start}
              required
              disabled={pending}
            />
          </label>

          <label className="space-y-2 text-sm font-semibold text-muted-foreground">
            <span>End</span>
            <Input
              name="end"
              type="time"
              defaultValue={initial.end}
              required
              disabled={pending}
            />
          </label>

          <Button type="submit" className="rounded-xl sm:w-auto" disabled={pending}>
            {pending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save"}
          </Button>
        </form>

        {state.error ? (
          <p className="mt-3 text-sm font-semibold text-destructive">{state.error}</p>
        ) : null}
        {state.ok ? (
          <p className="mt-3 text-sm font-semibold text-success">Saved.</p>
        ) : null}
      </CardContent>
    </Card>
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
  }

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
