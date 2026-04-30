"use client"

import type { Route } from "next"
import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  FileText,
  Home,
  LogOut,
  Receipt,
} from "lucide-react"

import { logoutAction } from "@/app/login/actions"
import { PushNotificationPrompt } from "@/components/pwa/push-notification-prompt"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import type { AuthenticatedSession } from "@/lib/auth/types"
import { cn } from "@/lib/utils"

type EmployeeNavItem = {
  href: string
  label: string
  icon: typeof Home
  supervisorOnly?: boolean
  children?: ReadonlyArray<{ href: string; label: string; supervisorOnly?: boolean }>
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
  },
  {
    href: "/employee/attendance",
    label: "Attendance",
    icon: CalendarClock,
    children: [
      { href: "/employee/attendance", label: "Dashboard" },
      { href: "/employee/attendance/history", label: "History" },
      { href: "/employee/attendance/team", label: "Team", supervisorOnly: true },
      { href: "/employee/attendance/approvals", label: "Approvals", supervisorOnly: true },
    ],
  },
  {
    href: "/employee/leave",
    label: "Leave",
    icon: CalendarDays,
  },
  {
    href: "/employee/payslip",
    label: "Payslip",
    icon: Receipt,
  },
  {
    href: "/employee/review",
    label: "Review",
    icon: ClipboardCheck,
    supervisorOnly: true,
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
    return "Claim History"
  }

  if (pathname.startsWith("/employee/review")) {
    return "Review Claims"
  }

  if (pathname.startsWith("/employee/leave")) {
    return "Leave"
  }

  if (pathname.startsWith("/employee/payslip")) {
    return "Payslip"
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
  pendingApprovals?: number
}

const APPROVALS_HREF = "/employee/attendance/approvals"
const ATTENDANCE_HREF = "/employee/attendance"

function NotificationDot() {
  return (
    <span
      aria-label="pending approvals"
      className="ml-auto inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-destructive shadow-[0_0_0_3px_rgba(255,255,255,0.6)]"
    />
  )
}

export function EmployeeShell({
  children,
  user,
  organizationName,
  pendingApprovals = 0,
}: EmployeeShellProps) {
  const pathname = usePathname()
  const visibleNav = employeeNav.filter(
    (item) => !("supervisorOnly" in item) || user.role === "SUPERVISOR"
  )
  const hasPendingApprovals = pendingApprovals > 0

  return (
    <div className="attendance-module !bg-transparent min-h-screen lg:grid lg:grid-cols-[280px_1fr]">
      <aside className="hidden h-screen flex-col border-r border-border/60 bg-card/72 p-6 backdrop-blur-xl lg:flex">
        <Link href="/" className="block self-center text-center">
          <Image
            src="/brand-logo.png"
            alt="ClaimGuard logo"
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
              (item.children !== undefined && pathname.startsWith(item.href + "/"))

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
                  {item.href === ATTENDANCE_HREF && hasPendingApprovals ? (
                    <NotificationDot />
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
                                ? "text-primary"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            <span>{child.label}</span>
                            {child.href === APPROVALS_HREF && hasPendingApprovals ? (
                              <NotificationDot />
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
        <header className="sticky top-0 z-30 border-b border-border/55 bg-background/82 backdrop-blur-xl">
          <div className="container flex items-center justify-between py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                ClaimGuard
              </p>
              <h1 className="font-headline text-2xl font-black tracking-tight">
                {getSectionTitle(pathname)}
              </h1>
              {organizationName ? (
                <p className="mt-1 text-sm text-muted-foreground">{organizationName}</p>
              ) : null}
            </div>
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
              <form action={logoutAction} suppressHydrationWarning>
                <Button type="submit" variant="ghost" size="sm" className="rounded-full">
                  <LogOut className="h-4 w-4" />
                  <span className="hidden sm:inline">Log out</span>
                </Button>
              </form>
            </div>
          </div>
        </header>

        <PushNotificationPrompt />

        <main className="flex-1 pb-40 lg:pb-10">
          <div className="container py-6 lg:py-8">{children}</div>
        </main>

        <nav className="glass-panel fixed inset-x-4 bottom-4 z-40 rounded-[40px] border border-border/60 px-3 py-2 shadow-panel lg:hidden">
          <div
            className={cn(
              "grid gap-1",
              user.role === "SUPERVISOR" ? "grid-cols-6" : "grid-cols-5"
            )}
          >
            {visibleNav.map((item) => {
              const active = pathname === item.href
              const Icon = item.icon

              const showDot =
                item.href === ATTENDANCE_HREF && hasPendingApprovals

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
                  {showDot ? (
                    <span
                      aria-label="pending approvals"
                      className="absolute right-2 top-2 h-2 w-2 rounded-full bg-destructive"
                    />
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
