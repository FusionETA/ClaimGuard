"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTransition } from "react"
import {
  CalendarClock,
  LayoutDashboard,
  LogOut,
  Network,
  Settings2,
} from "lucide-react"

import { logoutAction } from "@/app/login/actions"
import { switchActiveXeroConnectionAction } from "@/app/(admin)/admin/settings/actions"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import type { AuthenticatedSession } from "@/lib/auth/types"
import type { XeroConnectionInfo } from "@/modules/organization/domain/models"
import { cn } from "@/lib/utils"

type AdminNavItem = {
  href: string
  label: string
  icon: typeof LayoutDashboard
  children?: ReadonlyArray<{ href: string; label: string }>
}

const adminNav: ReadonlyArray<AdminNavItem> = [
  {
    href: "/admin",
    label: "Executive Overview",
    icon: LayoutDashboard,
  },
  {
    href: "/admin/hierarchy",
    label: "Hierarchy",
    icon: Network,
  },
  {
    href: "/admin/attendance",
    label: "Attendance",
    icon: CalendarClock,
    children: [
      { href: "/admin/attendance", label: "Overview" },
      { href: "/admin/attendance/approvals", label: "Approvals" },
    ],
  },
  {
    href: "/admin/settings",
    label: "Settings",
    icon: Settings2,
  },
]

function getTitle(pathname: string) {
  if (pathname.startsWith("/admin/hierarchy")) {
    return "Organization Hierarchy"
  }

  if (pathname.startsWith("/admin/settings")) {
    return "Organization Settings"
  }

  if (pathname.startsWith("/admin/attendance/approvals")) {
    return "Attendance Approvals"
  }

  if (pathname.startsWith("/admin/attendance")) {
    return "Attendance"
  }

  return "Executive Overview"
}

type AdminShellProps = {
  children: React.ReactNode
  user: AuthenticatedSession
  organizationName?: string
  xeroConnections?: XeroConnectionInfo[]
  activeXeroConnectionId?: string
}

export function AdminShell({ children, user, organizationName, xeroConnections = [], activeXeroConnectionId }: AdminShellProps) {
  const pathname = usePathname()
  const [switchPending, startSwitch] = useTransition()

  const hasMultipleConnections = xeroConnections.length > 1
  const activeConnection = xeroConnections.find((c) => c.id === activeXeroConnectionId) ?? xeroConnections[0]
  const displayName = activeConnection?.tenantName ?? organizationName

  function handleSwitch(connectionId: string) {
    startSwitch(() => switchActiveXeroConnectionAction(connectionId))
  }

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[300px_1fr]">
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
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Enterprise Admin
          </p>
        </Link>

        <nav className="mt-10 space-y-2">
          {adminNav.map((item) => {
            const Icon = item.icon
            const parentActive =
              pathname === item.href ||
              (item.children !== undefined && pathname.startsWith(item.href + "/"))

            return (
              <div key={item.href}>
                <Link
                  href={item.href}
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
                      const childActive = pathname === child.href
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
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
        <header className="sticky top-0 z-30 border-b border-border/55 bg-background/82 backdrop-blur-xl">
          <div className="container flex items-center justify-between py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Admin Portal
              </p>
              <h1 className="font-headline text-2xl font-black tracking-tight">
                {getTitle(pathname)}
              </h1>
              {hasMultipleConnections ? (
                <select
                  value={activeXeroConnectionId ?? ""}
                  disabled={switchPending}
                  onChange={(e) => handleSwitch(e.target.value)}
                  className="mt-1 h-8 rounded-lg border border-transparent bg-transparent px-0 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 cursor-pointer"
                >
                  {xeroConnections.map((conn) => (
                    <option key={conn.id} value={conn.id}>
                      {conn.tenantName}
                    </option>
                  ))}
                </select>
              ) : displayName ? (
                <p className="mt-1 text-sm text-muted-foreground">{displayName}</p>
              ) : null}
            </div>
            <div className="flex items-center">
              <div className="flex items-center gap-3 rounded-full border border-border/60 bg-card/90 px-3 py-2 shadow-ambient">
                <Avatar className="h-10 w-10">
                  <AvatarFallback>{user.initials}</AvatarFallback>
                </Avatar>
                <div className="hidden sm:block">
                  <p className="text-sm font-bold">{user.name}</p>
                  <p className="text-xs text-muted-foreground">{user.subtitle}</p>
                </div>
                <form action={logoutAction} suppressHydrationWarning>
                  <Button type="submit" variant="ghost" size="sm" className="rounded-full">
                    <LogOut className="h-4 w-4" />
                    <span className="hidden sm:inline">Log out</span>
                  </Button>
                </form>
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 pb-28 lg:pb-10">
          <div className="container py-6 lg:py-8">{children}</div>
        </main>

        <nav className="glass-panel fixed inset-x-4 bottom-4 z-40 rounded-[40px] border border-border/60 px-3 py-2 shadow-panel lg:hidden">
          <div className="grid grid-cols-3 gap-1">
            {adminNav.map((item) => {
              const active = pathname === item.href
              const Icon = item.icon

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-[28px] px-2 py-3 text-[11px] font-semibold",
                    active ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </Link>
              )
            })}
          </div>
        </nav>
      </div>
    </div>
  )
}
