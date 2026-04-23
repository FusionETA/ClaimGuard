"use client"

import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Network,
  LayoutDashboard,
  LogOut,
} from "lucide-react"

import { logoutAction } from "@/app/login/actions"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import type { AuthenticatedSession } from "@/lib/auth/types"
import { cn } from "@/lib/utils"

const adminNav = [
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
] as const

function getTitle(pathname: string) {
  return pathname.startsWith("/admin/hierarchy") ? "Organization Hierarchy" : "Executive Overview"
}

type AdminShellProps = {
  children: React.ReactNode
  user: AuthenticatedSession
}

export function AdminShell({ children, user }: AdminShellProps) {
  const pathname = usePathname()

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[300px_1fr]">
      <aside className="hidden h-screen flex-col border-r border-border/60 bg-card/72 p-6 backdrop-blur-xl lg:flex">
        <Link href="/" className="flex items-center gap-3">
          <Image
            src="/icon.svg"
            alt="ClaimGuard icon"
            width={48}
            height={48}
            className="h-12 w-12"
            priority
          />
          <div>
            <p className="font-headline text-xl font-black tracking-tight text-primary">
              ClaimGuard
            </p>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Enterprise Admin
            </p>
          </div>
        </Link>

        <nav className="mt-10 space-y-2">
          {adminNav.map((item) => {
            const active = pathname === item.href
            const Icon = item.icon

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-[22px] border px-4 py-3 text-sm font-semibold transition-all",
                  active
                    ? "border-primary/40 bg-card text-primary shadow-ambient"
                    : "border-transparent text-muted-foreground hover:bg-surface-low hover:text-foreground"
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
                Admin Portal
              </p>
              <h1 className="font-headline text-2xl font-black tracking-tight">
                {getTitle(pathname)}
              </h1>
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

        <nav className="glass-panel fixed inset-x-4 bottom-4 z-40 rounded-[28px] border border-border/60 px-3 py-2 shadow-panel lg:hidden">
          <div className="grid grid-cols-2 gap-1">
            {adminNav.map((item) => {
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
