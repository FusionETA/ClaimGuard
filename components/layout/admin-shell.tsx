"use client"

import type { Route } from "next"
import Image from "next/image"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useActionState, useEffect, useState, useTransition } from "react"
import {
  Banknote,
  CalendarClock,
  CalendarDays,
  History,
  LayoutDashboard,
  Loader2,
  Network,
  Plus,
  Receipt,
  Settings2,
} from "lucide-react"

import { ChangePasswordButton } from "@/components/layout/change-password-button"
import { LogoutButton } from "@/components/layout/logout-button"
import { NotificationBell } from "@/components/layout/notification-bell"
import { RealtimeListener } from "@/components/layout/realtime-listener"
import {
  createOrganizationAction,
  switchActiveOrganizationAction,
} from "@/app/(admin)/admin/settings/actions"
import { initialSettingsActionState } from "@/app/(admin)/admin/settings/form-state"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToastOnAction } from "@/components/ui/toaster"
import type { AuthenticatedSession } from "@/lib/auth/types"
import type { AdminOrganizationOption } from "@/modules/organization/domain/models"
import { cn } from "@/lib/utils"

/**
 * Sentinel value used by the "+ Add company" item inside the org switcher
 * dropdown. Picked instead of an org id, this is intercepted in
 * `onValueChange` to open the create-company dialog instead of switching.
 */
const ADD_COMPANY_SENTINEL = "__add_company"

type AdminNavItem = {
  href: Route
  label: string
  icon: typeof LayoutDashboard
  /// Module keys (from `ADMIN_MODULES`) that gate visibility of this
  /// item. Item is shown when the admin has ANY of these modules. Omit
  /// for items that should always be visible (Executive Overview).
  requiresModules?: ReadonlyArray<string>
  children?: ReadonlyArray<{
    href: Route
    label: string
    /// Optional per-child gate. Same semantics as the parent's
    /// `requiresModules`: child is shown only when the admin has at
    /// least one of these modules. Omit for children that should
    /// always be visible (e.g. Manage Employee, which renders as a
    /// read-only browse when `hierarchy` is not granted).
    requiresModules?: ReadonlyArray<string>
  }>
}

const adminNav: ReadonlyArray<AdminNavItem> = [
  {
    // Always visible — every admin needs a landing page.
    href: "/admin",
    label: "Executive Overview",
    icon: LayoutDashboard,
  },
  {
    href: "/admin/attendance",
    label: "Attendance",
    icon: CalendarClock,
    requiresModules: ["attendance"],
    children: [
      { href: "/admin/attendance", label: "Overview" },
      { href: "/admin/attendance/employees", label: "Employees" },
      { href: "/admin/attendance/ot" as Route, label: "Overtime" },
      { href: "/admin/attendance/shifts" as Route, label: "Shifts" },
    ],
  },
  {
    href: "/admin/claims",
    label: "Claims",
    icon: Receipt,
    // Claims is split into Personal + Company sub-modules. Show the
    // parent if the admin has EITHER. The Claims queue page itself can
    // further filter what rows are visible based on the more specific
    // key.
    requiresModules: ["claims_personal", "claims_company"],
    children: [
      { href: "/admin/claims", label: "Queue" },
      { href: "/admin/claims/payroll-ready" as Route, label: "Ready to Pay" },
      { href: "/admin/claims/breakdown" as Route, label: "Reports" },
      { href: "/admin/claims/settings" as Route, label: "Settings" },
    ],
  },
  {
    // Payroll module. Parent navigates to overview; children jump to
    // the most-used surfaces. Routes cast to `Route` because next/types
    // regenerates the union on build and the static tsc cache doesn't
    // see them until the next regeneration.
    href: "/admin/payroll" as Route,
    label: "Payroll",
    icon: Banknote,
    requiresModules: ["payroll"],
    children: [
      { href: "/admin/payroll" as Route, label: "Overview" },
      { href: "/admin/payroll/runs" as Route, label: "Payroll Runs" },
      {
        href: "/admin/payroll/annual-forms" as Route,
        label: "Annual Tax Forms",
      },
      { href: "/admin/payroll/loans" as Route, label: "Loans" },
      { href: "/admin/payroll/settings" as Route, label: "Settings" },
    ],
  },
  {
    // Cast to Route — next/types regenerates the Route union from app/**/page
    // on dev/build, but the static tsc pass against the cached .next/types
    // doesn't see new routes until the next regeneration.
    href: "/admin/leave" as Route,
    label: "Leave",
    icon: CalendarDays,
    requiresModules: ["leave"],
    children: [
      { href: "/admin/leave" as Route, label: "Overview" },
      { href: "/admin/leave/balances" as Route, label: "Balances" },
      { href: "/admin/leave/settings" as Route, label: "Settings" },
    ],
  },
  {
    // Parent navigates to the first child (Company Structure), matching
    // the order shown in the dropdown. Clicking parent → first child is
    // the standard admin-nav pattern; without this the parent would
    // always land on /admin/hierarchy (Employees) regardless of order.
    //
    // Parent has no `requiresModules` — Manage Employee is the read-only
    // browse surface that every admin can see (mutations are disabled
    // when `hierarchy` is not granted). The Company Structure child is
    // gated separately below.
    href: "/admin/company-structure" as Route,
    label: "Company/Employee",
    icon: Network,
    children: [
      {
        href: "/admin/company-structure" as Route,
        label: "Company Structure",
        requiresModules: ["company_structure"],
      },
      { href: "/admin/hierarchy" as Route, label: "Manage Employee" },
    ],
  },
  {
    // Per-org activity feed. Server-side fetch (auditLogRepository) with a
    // 7-day rolling retention prune-cron. Standalone page for now — can
    // move into Settings later if we want fewer top-level items.
    href: "/admin/audit" as Route,
    label: "Activity Log",
    icon: History,
    requiresModules: ["audit_log"],
  },
  {
    href: "/admin/settings",
    label: "System Settings",
    icon: Settings2,
    requiresModules: ["settings"],
    children: [
      { href: "/admin/settings?tab=organization", label: "Organization" },
      { href: "/admin/settings?tab=accounts", label: "Accounts" },
      { href: "/admin/settings?tab=projects", label: "Projects" },
      { href: "/admin/settings?tab=work-schedule", label: "Work Schedule" },
      { href: "/admin/settings?tab=policies", label: "Policies" },
      // API tab hidden — tokens are auto-issued by the partner master-key
      // flow (POST /api/v1/admin/organizations). Re-enable when self-service
      // integrations ship for direct customers.
      // { href: "/admin/settings?tab=api", label: "API" },
    ],
  },
]

/**
 * Filter the admin nav by an admin's module-access scope. `accessModules`
 * comes from the AdminOrganization row for the active org — `null` means
 * full access (owners, legacy admins with no row). When a list is passed,
 * we keep items whose `requiresModules` overlaps the granted set, and
 * always keep items without a `requiresModules` declaration (Executive
 * Overview).
 */
function filterAdminNav(
  nav: ReadonlyArray<AdminNavItem>,
  accessModules: ReadonlyArray<string> | null,
): ReadonlyArray<AdminNavItem> {
  if (accessModules === null) return nav
  const granted = new Set(accessModules)
  const itemAllowed = (req: ReadonlyArray<string> | undefined) =>
    !req || req.length === 0 || req.some((m) => granted.has(m))
  return nav
    .map((item) => {
      const children = item.children?.filter((c) => itemAllowed(c.requiresModules))
      if (!children) return item
      // When the parent's declared href points at a child that got
      // filtered out, redirect the parent click to the first remaining
      // child. Otherwise admins land on a forbidden page — e.g. the
      // Company/Employee parent points at /admin/company-structure, but
      // a `hierarchy`-only admin should jump to /admin/hierarchy.
      const declaredChildVisible = item.children?.some(
        (c) => c.href === item.href && children.some((kept) => kept.href === c.href),
      )
      const parentHref =
        declaredChildVisible || !children[0] ? item.href : children[0].href
      return { ...item, children, href: parentHref }
    })
    .filter((item) => {
      if (!itemAllowed(item.requiresModules)) return false
      // Drop parents whose every child got filtered out (avoid an empty
      // dropdown). Parents with no children declared aren't affected.
      if (item.children && item.children.length === 0) return false
      return true
    })
}

function getTitle(pathname: string) {
  if (pathname.startsWith("/admin/claims")) {
    return "Claims"
  }

  if (pathname.startsWith("/admin/leave")) {
    return "Leave"
  }

  if (pathname.startsWith("/admin/hierarchy")) {
    return "Manage Employee"
  }

  // Per-employee detail editor — see the nav-active override below for
  // the same reasoning. Listed BEFORE the /admin/payroll branch so
  // payroll's broader match doesn't claim it.
  if (pathname.startsWith("/admin/payroll/employees/")) {
    return "Manage Employee"
  }

  if (pathname.startsWith("/admin/company-structure")) {
    return "Company Structure"
  }

  if (pathname.startsWith("/admin/settings")) {
    return "System Settings"
  }

  if (pathname.startsWith("/admin/attendance/employees")) {
    return "Employees"
  }

  if (pathname.startsWith("/admin/attendance/ot")) {
    return "Overtime"
  }

  if (pathname.startsWith("/admin/attendance")) {
    return "Attendance"
  }

  if (pathname.startsWith("/admin/audit")) {
    return "Activity Log"
  }

  if (pathname.startsWith("/admin/payroll")) {
    return "Payroll"
  }

  return "Executive Overview"
}

type AdminShellProps = {
  children: React.ReactNode
  user: AuthenticatedSession
  organizationName?: string
  activeOrganizationId?: string
  /// Module-access scope for the active org. `null` = full access
  /// (Owner role or legacy admin without an AdminOrganization row).
  /// A `string[]` (possibly empty) restricts the visible sidebar nav
  /// to items whose `requiresModules` overlaps the array. Resolved
  /// server-side by the layout and threaded down; the client doesn't
  /// re-fetch it.
  accessModules?: ReadonlyArray<string> | null
}

export function AdminShell({
  children,
  user,
  organizationName,
  activeOrganizationId,
  accessModules,
}: AdminShellProps) {
  // Filter the full nav down to what this admin is allowed to see.
  // `null` (default) → keep everything (owner / legacy admin).
  const visibleNav = filterAdminNav(adminNav, accessModules ?? null)
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [switchPending, startSwitch] = useTransition()
  const [adminOrganizations, setAdminOrganizations] = useState<
    AdminOrganizationOption[]
  >([])
  const [resolvedActiveOrganizationId, setResolvedActiveOrganizationId] = useState(
    activeOrganizationId,
  )

  useEffect(() => {
    const controller = new AbortController()

    void fetch("/api/admin/context", {
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          return null
        }

        return response.json() as Promise<{
          adminOrganizations?: AdminOrganizationOption[]
          activeOrganizationId?: string | null
        }>
      })
      .then((data) => {
        setAdminOrganizations(data?.adminOrganizations ?? [])
        setResolvedActiveOrganizationId(
          data?.activeOrganizationId ?? activeOrganizationId,
        )
      })
      .catch(() => null)

    return () => controller.abort()
  }, [activeOrganizationId])

  // Show the dropdown whenever the admin has at least one company so the
  // "+ Add company" affordance lives in a single, predictable place. Single-
  // org admins still see a dropdown (with one entry) instead of plain text.
  const hasOrgs = adminOrganizations.length >= 1
  const activeOrg =
    adminOrganizations.find((o) => o.id === resolvedActiveOrganizationId) ??
    adminOrganizations[0]
  const displayName = activeOrg?.name ?? organizationName

  function handleOrgSwitch(orgId: string) {
    setResolvedActiveOrganizationId(orgId)
    startSwitch(async () => {
      await switchActiveOrganizationAction(orgId)
      // The action's revalidatePath() marks the server cache as stale
      // but the *client* router still has the previous RSC payload
      // cached. Without router.refresh() the dropdown label updates
      // but the page contents (attendance overview, claims, etc.) stay
      // showing the old org's data until the user navigates somewhere.
      // Calling refresh() here forces a fresh server render of the
      // current route with the new activeOrganizationId.
      router.refresh()
    })
  }

  // Add-company dialog state. The form lives inline in the header so the
  // create flow is reachable from any admin page without needing to navigate
  // to Settings → Organization first.
  const [addCompanyOpen, setAddCompanyOpen] = useState(false)
  const [createOrgState, createOrgAction, createOrgPending] = useActionState(
    createOrganizationAction,
    initialSettingsActionState
  )
  useToastOnAction(createOrgState)

  // Close the dialog when the server action reports success. The action also
  // calls `revalidateAdminSurfaces()` server-side, which re-renders this layout
  // with a new `activeOrganizationId` prop — that triggers the effect above
  // and refetches the org list, so the dropdown picks up the new entry.
  useEffect(() => {
    if (createOrgState.status === "success") {
      setAddCompanyOpen(false)
    }
  }, [createOrgState.status, createOrgState.message])

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[300px_1fr]">
      <aside className="hidden h-screen flex-col border-r border-border/60 bg-card/72 p-6 backdrop-blur-xl lg:flex print:hidden">
        <Link href="/" className="block self-center text-center">
          <Image
            src="/brand-logo.png"
            alt="AltomateHR logo"
            width={1280}
            height={851}
            className="h-auto w-[148px] object-contain"
            priority
          />
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Enterprise Admin
          </p>
        </Link>

        <nav className="mt-10 space-y-2">
          {visibleNav.map((item) => {
            const Icon = item.icon
            // The per-employee detail editor still lives at the legacy
            // URL /admin/payroll/employees/[id], but conceptually it's
            // the "Manage Employee" drill-in (the list page at
            // /admin/payroll/employees redirects to /admin/hierarchy).
            // Treat that exact subtree as Company/Employee, so the
            // Payroll nav doesn't grab the highlight when an admin
            // opens an employee from the Manage Employee table.
            const isEmployeeDetailPath = pathname.startsWith(
              "/admin/payroll/employees/",
            )
            const forceCompanyEmployee =
              isEmployeeDetailPath &&
              item.href === ("/admin/company-structure" as Route)
            const suppressPayroll =
              isEmployeeDetailPath && item.href === ("/admin/payroll" as Route)
            const parentActive =
              forceCompanyEmployee ||
              (!suppressPayroll &&
                (pathname === item.href ||
                  (item.children !== undefined &&
                    (pathname.startsWith(item.href + "/") ||
                      item.children.some((c) => {
                        // Strip query string from child href when matching path —
                        // child.href may be "/x?tab=y" but pathname is just "/x".
                        const childPath = c.href.split("?")[0]
                        return (
                          pathname === childPath ||
                          pathname.startsWith(childPath + "/")
                        )
                      })))))

            return (
              <div key={item.href}>
                <Link
                  href={item.href as Route}
                  className={cn(
                    "flex items-center gap-3 rounded-[22px] border px-4 py-3 text-sm font-semibold transition-all",
                    parentActive
                      ? "border-primary/40 bg-card text-primary shadow-ambient"
                      : "border-transparent text-muted-foreground hover:bg-surface-low hover:text-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>

                {item.children && parentActive ? (
                  <div className="mt-1 space-y-0.5 border-l border-border/60 pl-4 ml-5">
                    {item.children.map((child) => {
                      // Support both path-based and ?tab= query-param-based children
                      const childTabMatch = child.href.match(/[?&]tab=([^&]+)/)
                      const childSectionMatch = child.href.match(/[?&]section=([^&]+)/)
                      const childTab = childTabMatch?.[1] ?? null
                      const childSection = childSectionMatch?.[1] ?? null
                      const currentTab = searchParams.get("tab") ?? "organization"
                      const currentSection = searchParams.get("section")
                      const childActive = childTab
                        ? pathname === item.href &&
                          currentTab === childTab &&
                          (childSection ? currentSection === childSection : true)
                        : pathname === child.href
                      return (
                        <Link
                          key={child.href}
                          href={child.href as Route}
                          className={cn(
                            "block rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                            childActive
                              ? "text-primary"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          {child.label}
                        </Link>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            )
          })}
        </nav>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-30 border-b border-border/55 bg-background/82 backdrop-blur-xl print:hidden">
          <div className="container flex items-center justify-between py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Admin Portal
              </p>
              <h1 className="font-headline text-2xl font-black tracking-tight">
                {getTitle(pathname)}
              </h1>
              {hasOrgs ? (
                <div className="mt-1 inline-block">
                  <Select
                    value={resolvedActiveOrganizationId ?? undefined}
                    onValueChange={(v) => {
                      // Intercept the sentinel before treating it as an org id —
                      // we never want to set it as the active company.
                      if (v === ADD_COMPANY_SENTINEL) {
                        setAddCompanyOpen(true)
                        return
                      }
                      handleOrgSwitch(v)
                    }}
                    disabled={switchPending}
                  >
                    <SelectTrigger className="h-8 w-auto min-w-[200px] gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-sm text-muted-foreground shadow-none hover:border-border/60 hover:bg-card/60 sm:h-8 sm:text-sm">
                      <SelectValue placeholder="Select company" />
                    </SelectTrigger>
                    <SelectContent>
                      {adminOrganizations.map((org) => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))}
                      {/* SSO sessions can't add new companies here — the
                          partner system (Altomate Accounting) provisions
                          organisations server-to-server via
                          POST /api/v1/admin/organizations. Letting the
                          customer create one through our UI would diverge
                          from the partner's source of truth. */}
                      {user.loggedInViaSso ? null : (
                        <>
                          <SelectSeparator />
                          <SelectItem
                            value={ADD_COMPANY_SENTINEL}
                            className="font-semibold text-primary focus:text-primary"
                          >
                            <span className="inline-flex items-center gap-2">
                              <Plus className="h-4 w-4" />
                              Add company
                            </span>
                          </SelectItem>
                        </>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              ) : displayName ? (
                <p className="mt-1 text-sm text-muted-foreground">{displayName}</p>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <RealtimeListener />
              <NotificationBell />
              <div className="flex items-center gap-3 rounded-full border border-border/60 bg-card/90 px-3 py-2 shadow-ambient">
                <Avatar className="h-10 w-10">
                  <AvatarFallback>{user.initials}</AvatarFallback>
                </Avatar>
                <div className="hidden sm:block">
                  <p className="text-sm font-bold">{user.name}</p>
                  <p className="text-xs text-muted-foreground">{user.subtitle}</p>
                </div>
                {/* SSO sessions hide Change Password + Log Out —
                    those customers sign in via Altomate Accounting
                    (no useful password here, session managed there).
                    Password / direct logins see both buttons. */}
                {user.loggedInViaSso ? null : (
                  <>
                    <ChangePasswordButton />
                    <LogoutButton />
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 pb-28 lg:pb-10">
          <div className="container py-6 lg:py-8">{children}</div>
        </main>

        <nav className="glass-panel fixed inset-x-4 bottom-4 z-40 rounded-[40px] border border-border/60 px-3 py-2 shadow-panel lg:hidden print:hidden">
          <div className="grid grid-cols-4 gap-1">
            {visibleNav.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(item.href + "/")
              const Icon = item.icon

              return (
                <Link
                  key={item.href}
                  href={item.href as Route}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-[28px] px-1.5 py-3 text-center text-[10px] font-semibold leading-tight",
                    active ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="line-clamp-2">{item.label}</span>
                </Link>
              )
            })}
          </div>
        </nav>
      </div>

      {/* "+ Add company" dialog — opened from the org switcher dropdown.
          Lives at the layout root so the Portal renders above sticky headers
          and bottom navs on every admin page. */}
      <Dialog open={addCompanyOpen} onOpenChange={setAddCompanyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add company</DialogTitle>
            <DialogDescription>
              Create a separate company workspace. You can switch between
              companies anytime from this dropdown.
            </DialogDescription>
          </DialogHeader>
          <form action={createOrgAction} className="space-y-4">
            <label className="space-y-2 text-sm font-semibold text-muted-foreground">
              <span>Company name</span>
              <Input
                name="name"
                required
                autoFocus
                disabled={createOrgPending}
              />
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="rounded-xl"
                onClick={() => setAddCompanyOpen(false)}
                disabled={createOrgPending}
              >
                Cancel
              </Button>
              <Button type="submit" className="rounded-xl" disabled={createOrgPending}>
                {createOrgPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    <Plus className="mr-2 h-4 w-4" />
                    Add company
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
