"use client"

import type { Route } from "next"
import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import {
  CalendarClock,
  CalendarDays,
  FileText,
  Home,
  Receipt,
} from "lucide-react"

import { ChangePasswordButton } from "@/components/layout/change-password-button"
import { LogoutButton } from "@/components/layout/logout-button"
import { MobileUserActions } from "@/components/layout/mobile-user-actions"
import { NotificationBell } from "@/components/layout/notification-bell"
import { RealtimeListener } from "@/components/layout/realtime-listener"
import { SwitchCompanyButton } from "@/components/layout/switch-company-button"
import { PushNotificationPrompt } from "@/components/pwa/push-notification-prompt"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import type { AuthenticatedSession } from "@/lib/auth/types"
import {
  registerBadgeRefreshHandler,
  registerClaimsReviewedHandler,
} from "@/lib/badge-refresh"
import { cn } from "@/lib/utils"

type EmployeeNavItem = {
  href: Route
  label: string
  icon: typeof Home
  supervisorOnly?: boolean
  children?: ReadonlyArray<{ href: Route; label: string; supervisorOnly?: boolean }>
}

const employeeNav: ReadonlyArray<EmployeeNavItem> = [
  {
    href: "/employee",
    label: "Dashboard",
    icon: Home,
  },
  {
    href: "/employee/claims",
    label: "Claims",
    icon: FileText,
    children: [
      { href: "/employee/claims", label: "My claims" },
      { href: "/employee/review", label: "Claims queue", supervisorOnly: true },
    ],
  },
  {
    href: "/employee/attendance",
    label: "Attendance",
    icon: CalendarClock,
    children: [
      { href: "/employee/attendance", label: "Dashboard" },
      { href: "/employee/attendance/history", label: "History" },
      { href: "/employee/attendance/overtime", label: "Overtime" },
      { href: "/employee/attendance/team", label: "Team", supervisorOnly: true },
      { href: "/employee/attendance/approvals", label: "Approvals", supervisorOnly: true },
    ],
  },
  {
    href: "/employee/leave",
    label: "Leave",
    icon: CalendarDays,
    children: [
      { href: "/employee/leave", label: "My Leave" },
      { href: "/employee/leave/team" as Route, label: "Team Balances", supervisorOnly: true },
      { href: "/employee/leave/approvals" as Route, label: "Approvals", supervisorOnly: true },
    ],
  },
  {
    href: "/employee/payslips" as Route,
    label: "Payslips",
    icon: Receipt,
  },
]

function getSectionTitle(pathname: string) {
  if (pathname.startsWith("/employee/account")) {
    return "Account"
  }

  if (pathname.startsWith("/employee/claims/new")) {
    return "Submit Claim"
  }

  if (pathname.startsWith("/employee/claims")) {
    return "My Claims"
  }

  if (pathname.startsWith("/employee/review")) {
    return "Claims Queue"
  }

  if (pathname.startsWith("/employee/leave")) {
    return "Leave"
  }

  if (pathname.startsWith("/employee/payslips")) {
    return "Payslips"
  }

  if (pathname.startsWith("/employee/attendance/history")) {
    return "Attendance History"
  }

  if (pathname.startsWith("/employee/attendance/team")) {
    return "Team Attendance"
  }

  if (pathname.startsWith("/employee/attendance/approvals")) {
    return "Approvals"
  }

  if (pathname.startsWith("/employee/attendance")) {
    return "My Attendance"
  }

  return "Employee Portal"
}

type EmployeeShellProps = {
  children: React.ReactNode
  user: AuthenticatedSession
  organizationName?: string
  /// Effective module-access flags from the employee's assigned policy.
  /// When undefined, all modules are visible (legacy behavior for orgs
  /// that pre-date policy assignment).
  moduleAccess?: {
    attendance: boolean
    claims: boolean
    leave: boolean
  }
  /// True when the signed-in user holds 2+ active EmployeeOrganization
  /// memberships. Drives whether the "Switch Company" header button is
  /// rendered — single-org employees never see it.
  hasMultipleCompanies?: boolean
}

const APPROVALS_HREF = "/employee/attendance/approvals"
const ATTENDANCE_HREF = "/employee/attendance"
const CLAIMS_HREF = "/employee/claims"
const CLAIMS_QUEUE_HREF = "/employee/review"
const LEAVE_HREF = "/employee/leave"
// Cast through `string` so the comparison below doesn't get narrowed against
// the cached next/types Route union (which may not yet include the new
// leave approvals route after a fresh code generation).
const LEAVE_APPROVALS_HREF = "/employee/leave/approvals" as string

function NotificationCountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null
  return (
    <span
      aria-label={`${count} pending approval${count === 1 ? "" : "s"}`}
      className={cn(
        "ml-auto flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}

export function EmployeeShell({
  children,
  user,
  organizationName,
  moduleAccess,
  hasMultipleCompanies,
}: EmployeeShellProps) {
  const pathname = usePathname()
  const [displayOrganizationName, setDisplayOrganizationName] = useState(
    organizationName,
  )
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [pendingClaimApprovals, setPendingClaimApprovals] = useState(0)
  const [pendingLeaveApprovals, setPendingLeaveApprovals] = useState(0)

  const fetchContext = useCallback(
    (signal?: AbortSignal) => {
      return fetch("/api/employee/context", {
        cache: "no-store",
        credentials: "include",
        signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            return null
          }

          return response.json() as Promise<{
            organizationName?: string | null
            pendingApprovals?: number
            pendingClaimApprovals?: number
            pendingLeaveApprovals?: number
          }>
        })
        .then((data) => {
          if (data?.organizationName) {
            setDisplayOrganizationName(data.organizationName)
          }

          setPendingApprovals(data?.pendingApprovals ?? 0)
          setPendingClaimApprovals(data?.pendingClaimApprovals ?? 0)
          setPendingLeaveApprovals(data?.pendingLeaveApprovals ?? 0)
        })
        .catch(() => null)
    },
    [],
  )

  // Keep the header's displayed org name in sync with the prop from
  // the server layout. When a multi-org employee switches company,
  // the layout re-renders with the new active org's name; without
  // this sync the shell (which persists across route changes in the
  // same layout) would keep showing the initial-mount value.
  useEffect(() => {
    if (organizationName) {
      setDisplayOrganizationName(organizationName)
    }
  }, [organizationName])

  useEffect(() => {
    if (user.role !== "SUPERVISOR" && organizationName) {
      return
    }

    const controller = new AbortController()
    void fetchContext(controller.signal)
    return () => controller.abort()
  }, [organizationName, user.role, fetchContext])

  // Re-pull the badge counts whenever the supervisor navigates between
  // pages. Belt-and-braces for the rare case where the optimistic event
  // path below misses (HMR, dropped event, etc.) — at worst the badge
  // becomes correct the next time they click a nav item.
  useEffect(() => {
    if (user.role !== "SUPERVISOR") return
    const controller = new AbortController()
    void fetchContext(controller.signal)
    return () => controller.abort()
  }, [pathname, user.role, fetchContext])

  // After a supervisor approves/rejects a claim, AdminClaimReviewActions
  // calls `notifyClaimsReviewed()` (a module-level callback registry —
  // see lib/badge-refresh.ts) so the navigation badge can decrement
  // immediately instead of waiting for the next mount. We optimistically
  // drop the count by 1 and then re-sync from the server for accuracy
  // (in case there were concurrent submissions). The re-sync is delayed
  // slightly so the DB transaction has time to settle — without the
  // delay we'd occasionally read the OLD count and overwrite the
  // optimistic 0.
  useEffect(() => {
    if (user.role !== "SUPERVISOR") return

    registerClaimsReviewedHandler(() => {
      setPendingClaimApprovals((current) => Math.max(0, current - 1))
      window.setTimeout(() => {
        void fetchContext()
      }, 400)
    })
    return () => registerClaimsReviewedHandler(null)
  }, [user.role, fetchContext])

  // After an attendance/leave approve or reject, the list calls
  // `notifyBadgeRefresh()` so the nav pills + shortcut cards re-sync
  // immediately (those flows don't navigate away, so the badge would
  // otherwise stay stale until the next mount/navigation). Slight delay so
  // the DB transaction settles before we re-read the counts.
  useEffect(() => {
    if (user.role !== "SUPERVISOR") return
    registerBadgeRefreshHandler(() => {
      window.setTimeout(() => {
        void fetchContext()
      }, 400)
    })
    return () => registerBadgeRefreshHandler(null)
  }, [user.role, fetchContext])

  // SSE: when the realtime listener (mounted lower in this shell) gets
  // a push from the server — e.g. a subordinate submitted a new claim,
  // attendance approval, or leave application aimed at THIS supervisor
  // — re-pull the badge counts so the sidebar pills + homepage shortcut
  // cards update without waiting for navigation or the page reload.
  //
  // Without this, RealtimeListener's `router.refresh()` re-renders the
  // current server-rendered page (the queue list updates) but the
  // shell's `pending*Approvals` state is client-side and would stay
  // stale until the supervisor clicked something.
  useEffect(() => {
    if (user.role !== "SUPERVISOR") return
    function handleRealtime() {
      void fetchContext()
    }
    window.addEventListener("altomate:realtime", handleRealtime)
    return () => window.removeEventListener("altomate:realtime", handleRealtime)
  }, [user.role, fetchContext])

  const visibleNav = employeeNav
    .filter((item) => !("supervisorOnly" in item) || user.role === "SUPERVISOR")
    .filter((item) => {
      if (!moduleAccess) return true
      if (item.href === ATTENDANCE_HREF) return moduleAccess.attendance
      if (item.href === CLAIMS_HREF) return moduleAccess.claims
      if (item.href === "/employee/leave") return moduleAccess.leave
      return true
    })

  return (
    <div className="attendance-module min-h-screen bg-background [background-image:none] lg:grid lg:grid-cols-[280px_1fr]">
      <aside className="hidden min-h-screen flex-col border-r border-border/60 bg-card/72 p-6 backdrop-blur-xl lg:flex print:hidden">
        <Link href="/" className="block self-center text-center">
          <Image
            src="/brand-logo.png"
            alt="AltomateHR logo"
            width={1280}
            height={851}
            className="h-auto w-[148px] object-contain"
            priority
          />
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Employee Portal
          </p>
        </Link>

        <nav className="mt-10 space-y-2">
          {visibleNav.map((item) => {
            const Icon = item.icon
            const parentActive =
              pathname === item.href ||
              (item.children !== undefined && (
                pathname.startsWith(item.href + "/") ||
                item.children.some((c) => pathname === c.href || pathname.startsWith(c.href + "/"))
              ))

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
                  <span>{item.label}</span>
                  {item.href === ATTENDANCE_HREF ? (
                    <NotificationCountBadge count={pendingApprovals} />
                  ) : item.href === CLAIMS_HREF ? (
                    <NotificationCountBadge count={pendingClaimApprovals} />
                  ) : item.href === LEAVE_HREF ? (
                    <NotificationCountBadge count={pendingLeaveApprovals} />
                  ) : null}
                </Link>

                {item.children && parentActive ? (
                  <div className="mt-1 space-y-0.5 border-l border-border/60 pl-4 ml-5">
                    {item.children
                      .filter((c) => !c.supervisorOnly || user.role === "SUPERVISOR")
                      .map((child) => {
                        const childActive = pathname === child.href
                        return (
                          <Link
                            key={child.href}
                            href={child.href as Route}
                            className={cn(
                              "flex items-center rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                              childActive
                                ? "bg-primary/10 text-primary"
                                : "text-muted-foreground hover:bg-surface-low hover:text-foreground"
                            )}
                          >
                            <span>{child.label}</span>
                            {child.href === APPROVALS_HREF ? (
                              <NotificationCountBadge count={pendingApprovals} />
                            ) : child.href === CLAIMS_QUEUE_HREF ? (
                              <NotificationCountBadge count={pendingClaimApprovals} />
                            ) : child.href === LEAVE_APPROVALS_HREF ? (
                              <NotificationCountBadge count={pendingLeaveApprovals} />
                            ) : null}
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
                AltomateHR
              </p>
              <h1 className="font-headline text-2xl font-black tracking-tight">
                {getSectionTitle(pathname)}
              </h1>
              {displayOrganizationName ? (
                <p className="mt-1 text-sm text-muted-foreground">{displayOrganizationName}</p>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <RealtimeListener />
              <NotificationBell />
              <div className="flex items-center gap-3 rounded-full border border-border/60 bg-card/90 px-3 py-2 shadow-ambient">
                <Link
                  href="/employee/account"
                  className="flex items-center gap-3 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background"
                >
                  <Avatar className="h-10 w-10">
                    <AvatarFallback>{user.initials}</AvatarFallback>
                  </Avatar>
                  <div className="hidden text-right sm:block">
                    <p className="text-sm font-bold">{user.name}</p>
                    <p className="text-xs text-muted-foreground">{user.subtitle}</p>
                  </div>
                </Link>
                {/* Desktop (`sm+`): three inline round icon buttons.
                    Mobile (`<sm`): collapsed into a single 3-dot menu
                    (below) to keep the header pill compact. Both
                    paths reuse the same button components. */}
                <div className="hidden items-center gap-3 sm:flex">
                  {hasMultipleCompanies ? <SwitchCompanyButton /> : null}
                  <ChangePasswordButton
                    hasMultipleCompanies={hasMultipleCompanies}
                  />
                  <LogoutButton />
                </div>
                <MobileUserActions
                  hasMultipleCompanies={hasMultipleCompanies}
                />
              </div>
            </div>
          </div>
        </header>

        <PushNotificationPrompt />

        <main className="flex-1 pb-40 lg:pb-10">
          <div className="container py-6 lg:py-8">{children}</div>
        </main>

        <nav className="glass-panel fixed inset-x-4 bottom-4 z-40 rounded-[40px] border border-border/60 px-3 py-2 shadow-panel lg:hidden print:hidden">
          <div
            className="grid grid-cols-5 gap-1"
          >
            {visibleNav.map((item) => {
              const active = pathname === item.href
              const Icon = item.icon

              // Unified pending count per primary tab (attendance / claims /
              // leave) so the bottom bar matches the side-nav number badges.
              const badgeCount =
                item.href === ATTENDANCE_HREF
                  ? pendingApprovals
                  : item.href === CLAIMS_HREF
                    ? pendingClaimApprovals
                    : item.href === LEAVE_HREF
                      ? pendingLeaveApprovals
                      : 0

              return (
                <Link
                  key={item.href}
                  href={item.href as Route}
                  className={cn(
                    "relative flex flex-col items-center gap-1 rounded-[28px] px-1.5 py-3 text-center text-[10px] font-semibold leading-tight",
                    active ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="line-clamp-2">{item.label}</span>
                  {badgeCount > 0 ? (
                    <span
                      aria-label={`${badgeCount} pending approval${badgeCount === 1 ? "" : "s"}`}
                      className="absolute right-1 top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground"
                    >
                      {badgeCount > 99 ? "99+" : badgeCount}
                    </span>
                  ) : null}
                </Link>
              )
            })}
          </div>
        </nav>
      </div>
    </div>
  )
}
