"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  CalendarClock,
  ClipboardCheck,
  LayoutDashboard,
  LogOut,
  Users,
} from "lucide-react"

import { logoutAction } from "@/app/login/actions"
import { PushNotificationPrompt } from "@/components/pwa/push-notification-prompt"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import type { AuthenticatedSession } from "@/lib/auth/types"
import { cn } from "@/lib/utils"

const supervisorNav = [
  {
    href: "/supervisor",
    label: "Overview",
    icon: LayoutDashboard,
  },
  {
    href: "/supervisor/attendance",
    label: "Attendance",
    icon: CalendarClock,
  },
  {
    href: "/supervisor/attendance/team",
    label: "Team",
    icon: Users,
  },
  {
    href: "/supervisor/attendance/approvals",
    label: "Approvals",
    icon: ClipboardCheck,
  },
] as const

function getSectionTitle(pathname: string) {
  if (pathname.startsWith("/supervisor/attendance/team")) return "Team Directory"
  if (pathname.startsWith("/supervisor/attendance/approvals")) return "Approvals"
  if (pathname.startsWith("/supervisor/attendance/employee")) return "Employee Profile"
  if (pathname.startsWith("/supervisor/attendance")) return "Team Attendance"
  return "Supervisor Portal"
}

type SupervisorShellProps = {
  children: React.ReactNode
  user: AuthenticatedSession
  organizationName?: string
}

export function SupervisorShell({
  children,
  user,
  organizationName,
}: SupervisorShellProps) {
  const pathname = usePathname()

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[280px_1fr]">
      <aside className="hidden h-screen flex-col border-r border-border/60 bg-card/72 p-6 backdrop-blur-xl lg:flex">
        <Link href="/supervisor" className="block self-center text-center">
          <Image
            src="/brand-logo.png"
            alt="ClaimGuard logo"
            width={1280}
            height={851}
            className="h-auto w-[148px] object-contain"
            priority
          />
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Supervisor Portal
          </p>
        </Link>

        <nav className="mt-10 space-y-2">
          {supervisorNav.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== "/supervisor" && pathname.startsWith(item.href + "/"))
            const Icon = item.icon

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-[22px] border px-4 py-3 text-sm font-semibold transition-all",
                  active
                    ? "border-primary/40 bg-card text-primary shadow-ambient"
                    : "border-transparent text-muted-foreground hover:bg-surface-low hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
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
              <Avatar className="h-10 w-10">
                <AvatarFallback>{user.initials}</AvatarFallback>
              </Avatar>
              <div className="hidden text-right sm:block">
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
        </header>

        <PushNotificationPrompt />

        <main className="flex-1 pb-40 lg:pb-10">
          <div className="container py-6 lg:py-8">{children}</div>
        </main>

        <nav className="glass-panel fixed inset-x-4 bottom-4 z-40 rounded-[40px] border border-border/60 px-3 py-2 shadow-panel lg:hidden">
          <div className="grid grid-cols-4 gap-1">
            {supervisorNav.map((item) => {
              const active =
                pathname === item.href ||
                (item.href !== "/supervisor" && pathname.startsWith(item.href + "/"))
              const Icon = item.icon

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-[28px] px-2 py-3 text-[11px] font-semibold",
                    active ? "bg-primary text-primary-foreground" : "text-muted-foreground",
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
