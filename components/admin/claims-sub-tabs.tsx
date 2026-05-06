"use client"

import Link from "next/link"
import type { Route } from "next"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

/**
 * Pill-style sub-tab nav rendered on both /admin/claims and
 * /admin/claims/breakdown so the admin can toggle between the action
 * queue (review claims) and the analytical breakdown view (spend by
 * project/team/member). Active tab is derived from pathname so the same
 * component drops into either page without prop wiring.
 */
const TABS: { label: string; href: Route; matches: (pathname: string) => boolean }[] = [
  {
    label: "Queue",
    href: "/admin/claims" as Route,
    matches: (p) => p === "/admin/claims" || p === "/admin/claims/",
  },
  {
    label: "By project",
    href: "/admin/claims/breakdown" as Route,
    matches: (p) => p.startsWith("/admin/claims/breakdown"),
  },
]

export function ClaimsSubTabs() {
  const pathname = usePathname() ?? ""

  return (
    <nav className="-mx-6 overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex gap-2 pb-0.5">
        {TABS.map((tab) => {
          const active = tab.matches(pathname)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
