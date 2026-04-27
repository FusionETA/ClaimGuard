"use client"

import { useActionState, useEffect, useState, useTransition } from "react"
import { Loader2, Plus, Search, Trash2 } from "lucide-react"

import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import {
  createCustomAccountAction,
  deleteCustomAccountAction,
  saveClaimRunSettingsAction,
  saveOrganizationSettingsAction,
  saveSelectableAccountsAction,
  selectXeroTenantAction,
  switchActiveXeroConnectionAction,
  syncXeroAccountsAction,
  syncXeroProjectsAction,
} from "@/app/(admin)/admin/settings/actions"
import { XeroConnectionCard } from "@/components/admin/xero-connection-card"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toaster"
import type { XeroTenant } from "@/lib/xero"
import type { AdminProfile } from "@/modules/claims/domain/models"
import type {
  ChartOfAccountOption,
  OrganizationProjectOption,
  OrganizationSummary,
  XeroConnectionSummary,
} from "@/modules/organization/domain/models"

type TabKey = "organization" | "accounts" | "projects" | "runs"

export function AdminSettingsPanel({
  admin,
  organization,
  xeroConnection,
  chartAccounts,
  customAccounts,
  projects,
  activeXeroConnectionId,
  xeroStatus,
  xeroReason,
  pendingTenants,
  takenTenantIds = [],
}: {
  admin: AdminProfile
  organization?: OrganizationSummary
  xeroConnection: XeroConnectionSummary
  chartAccounts: ChartOfAccountOption[]
  customAccounts: ChartOfAccountOption[]
  projects: OrganizationProjectOption[]
  activeXeroConnectionId?: string
  xeroStatus?: string
  xeroReason?: string
  pendingTenants?: XeroTenant[]
  takenTenantIds?: string[]
}) {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState<TabKey>("organization")
  const [accountTypeFilter, setAccountTypeFilter] = useState<string>("all")
  const [accountSearch, setAccountSearch] = useState("")
  const [projectSearch, setProjectSearch] = useState("")
  const [switchPending, startSwitch] = useTransition()

  // Custom mode = no Xero connections exist at all
  const isCustomMode = xeroConnection.connections.length === 0
  const activeConnection = xeroConnection.connections.find((c) => c.id === activeXeroConnectionId)

  const displayAccounts = isCustomMode ? customAccounts : chartAccounts
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

  return (
    <div className="space-y-6">
      {/* Main tab bar */}
      <div className="flex flex-wrap gap-2">
        {[
          ["organization", "Organization"],
          ["accounts", "Claim accounts"],
          ["projects", "Projects"],
          ["runs", "Claim runs"],
        ].map(([value, label]) => (
          <Button
            key={value}
            type="button"
            variant={activeTab === value ? "default" : "ghost"}
            className="rounded-full"
            onClick={() => setActiveTab(value as TabKey)}
          >
            {label}
          </Button>
        ))}
      </div>

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
                  Current admin
                </p>
                <p className="mt-2 text-lg font-black">{admin.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {admin.email}
                  {activeConnection?.tenantName
                    ? ` · ${activeConnection.tenantName}`
                    : organization?.name
                    ? ` · ${organization.name}`
                    : ""}
                </p>
              </div>

              <form action={organizationAction} className="space-y-4">
                <label className="space-y-2 text-sm font-semibold text-muted-foreground">
                  Organization name
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground/70">
                    {xeroConnection.connections.length > 0
                      ? "(optional — name comes from Xero)"
                      : "(optional)"}
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

      {activeTab === "projects" ? (
        <div className="space-y-6">

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>
                  {activeConnection
                    ? `Xero projects — ${activeConnection.tenantName}`
                    : "Available Xero projects"}
                </CardTitle>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Sync projects from Xero so they can be assigned to employees in the hierarchy tab.
                </p>
              </div>
              {activeXeroConnectionId ? (
                <form action={projectsAction}>
                  <input type="hidden" name="connectionId" value={activeXeroConnectionId} />
                  <Button type="submit" variant="outline" className="rounded-xl" disabled={projectsPending}>
                    {projectsPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Syncing…
                      </>
                    ) : (
                      "Sync Xero projects"
                    )}
                  </Button>
                </form>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              {projects.length === 0 ? (
                <div className="rounded-[24px] bg-surface-low p-5 text-sm leading-6 text-muted-foreground">
                  {activeXeroConnectionId
                    ? "No Xero projects have been imported yet. Use the Sync button."
                    : "Select a Xero connection above to see its projects."}
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
                      .filter(
                        (p) =>
                          projectSearchLower === "" ||
                          p.name.toLowerCase().includes(projectSearchLower)
                      )
                      .map((project) => (
                        <div
                          key={project.id}
                          className="rounded-[20px] border border-border/70 bg-surface-low p-4"
                        >
                          <p className="font-bold text-foreground">{project.name}</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {[project.status, project.xeroProjectId].filter(Boolean).join(" · ")}
                          </p>
                        </div>
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
                Cutoff day of month
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
    </div>
  )
}
