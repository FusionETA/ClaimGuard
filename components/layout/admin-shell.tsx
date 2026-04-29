"use client"

import type { Route } from "next"
import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTransition } from "react"
import {
  CalendarClock,
  LayoutDashboard,
  LogOut,
  Network,
  Receipt,
  Settings2,
} from "lucide-react"

import { logoutAction } from "@/app/login/actions"
import { switchActiveOrganizationAction } from "@/app/(admin)/admin/settings/actions"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AuthenticatedSession } from "@/lib/auth/types"
import type { AdminOrganizationOption, XeroConnectionInfo } from "@/modules/organization/domain/models"
import { cn } from "@/lib/utils"

type AdminNavItem = {
  href: Route
  label: string
  icon: typeof LayoutDashboard
  children?: ReadonlyArray<{ href: Route; label: string }>
}

const adminNav: ReadonlyArray<AdminNavItem> = [
  {
    href: "/admin",
    label: "Executive Overview",
    icon: LayoutDashboard,
  },
  {
    href: "/admin/claims",
    label: "Claims",
    icon: Receipt,
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
  },
  {
    href: "/admin/settings",
    label: "Settings",
    icon: Settings2,
  },
]

function getTitle(pathname: string) {
  if (pathname.startsWith("/admin/claims")) {
    return "Claims"
  }

  if (pathname.startsWith("/admin/hierarchy")) {
    return "Organization Hierarchy"
  }

  if (pathname.startsWith("/admin/settings")) {
    return "Organization Settings"
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
  adminOrganizations?: AdminOrganizationOption[]
  activeOrganizationId?: string
  xeroConnections?: XeroConnectionInfo[]
  activeXeroConnectionId?: string
}

export function AdminShell({
  children,
  user,
  organizationName,
  adminOrganizations = [],
  activeOrganizationId,
  xeroConnections = [],
  activeXeroConnectionId,
}: AdminShellProps) {
  const pathname = usePathname()
  const [switchPending, startSwitch] = useTransition()

  const hasMultipleOrgs = adminOrganizations.length > 1
  const activeOrg = adminOrganizations.find((o) => o.id === activeOrganizationId) ?? adminOrganizations[0]
  const displayName = activeOrg?.name ?? organizationName

  function handleOrgSwitch(orgId: string) {
    startSwitch(() => switchActiveOrganizationAction(orgId))
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
              {hasMultipleOrgs ? (
                <div className="mt-1 inline-block">
                  <Select
                    value={activeOrganizationId ?? undefined}
                    onValueChange={(v) => handleOrgSwitch(v)}
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
                    </SelectContent>
                  </Select>
                </div>
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
          <div className="grid grid-cols-4 gap-1">
            {adminNav.map((item) => {
              const active = pathname === item.href
              const Icon = item.icon

              return (
                <Link
                  key={item.href}
                  href={item.href}
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
    </div>
  )
}
