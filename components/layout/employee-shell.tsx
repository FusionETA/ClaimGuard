"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  CircleUserRound,
  FileText,
  Home,
  LogOut,
  Plus,
  ClipboardCheck,
  ShieldCheck,
} from "lucide-react"

import { logoutAction } from "@/app/login/actions"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import type { AuthenticatedSession } from "@/lib/auth/types"
import { cn } from "@/lib/utils"

const employeeNav = [
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
    href: "/employee/claims/new",
    label: "New Claim",
    icon: Plus,
  },
  {
    href: "/employee/review",
    label: "Review",
    icon: ClipboardCheck,
    supervisorOnly: true,
  },
  {
    href: "/employee/account",
    label: "Account",
    icon: CircleUserRound,
  },
] as const

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

  return "Employee Portal"
}

type EmployeeShellProps = {
  children: React.ReactNode
  user: AuthenticatedSession
}

export function EmployeeShell({ children, user }: EmployeeShellProps) {
  const pathname = usePathname()
  const visibleNav = employeeNav.filter(
    (item) => !("supervisorOnly" in item) || user.role === "SUPERVISOR"
  )

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[280px_1fr]">
      <aside className="hidden h-screen flex-col border-r border-white/30 bg-white/70 p-6 backdrop-blur-xl lg:flex">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-[#2a5084] text-primary-foreground shadow-panel">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <p className="font-headline text-xl font-black tracking-tight text-primary">
              ClaimGuard
            </p>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Employee Portal
            </p>
          </div>
        </Link>

        <nav className="mt-10 space-y-2">
          {visibleNav.map((item) => {
            const active = pathname === item.href
            const Icon = item.icon

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition-all",
                  active
                    ? "bg-surface-lowest text-primary shadow-ambient"
                    : "text-muted-foreground hover:bg-surface-low hover:text-foreground"
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
        <header className="sticky top-0 z-30 border-b border-white/40 bg-background/80 backdrop-blur-xl">
          <div className="container flex items-center justify-between py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                ClaimGuard
              </p>
              <h1 className="font-headline text-2xl font-black tracking-tight">
                {getSectionTitle(pathname)}
              </h1>
            </div>
            <div className="flex items-center gap-3 rounded-full bg-white/80 px-3 py-2 shadow-ambient">
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

        <main className="flex-1 pb-28 lg:pb-10">
          <div className="container py-6 lg:py-8">{children}</div>
        </main>

        <nav className="glass-panel fixed inset-x-4 bottom-4 z-40 rounded-[28px] border border-white/50 px-3 py-2 shadow-panel lg:hidden">
          <div
            className={cn(
              "grid gap-1",
              user.role === "SUPERVISOR" ? "grid-cols-5" : "grid-cols-4"
            )}
          >
            {visibleNav.map((item) => {
              const active = pathname === item.href
              const Icon = item.icon

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-2xl px-2 py-3 text-[11px] font-semibold",
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
