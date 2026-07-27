"use client"

import type { Route } from "next"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * Mobile-only sub-navigation for supervisors between their own leave,
 * the team balances view, and the approvals queue. Mirrors
 * `AttendanceSubNav` — the bottom mobile bar only surfaces the 5
 * primary tabs, so children like "Approvals" would otherwise be
 * unreachable on mobile. Hidden at lg+ where the sidebar already
 * exposes the child links. Non-supervisors keep just "My Leave".
 */
type SubNavItem = {
  href: Route
  label: string
  showPendingDot?: boolean
}

type Props = {
  role: string
  items: ReadonlyArray<SubNavItem>
}

const APPROVALS_HREF = "/employee/leave/approvals"

export function LeaveSubNav({ role, items }: Props) {
  const pathname = usePathname()
  const [hasPendingApprovals, setHasPendingApprovals] = useState(false)

  useEffect(() => {
    if (role !== "SUPERVISOR") return
    const supportsApprovals = items.some(
      (item) => item.href === APPROVALS_HREF,
    )
    if (!supportsApprovals) return

    const controller = new AbortController()
    void fetch("/api/employee/context", {
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return null
        return response.json() as Promise<{ pendingLeaveApprovals?: number }>
      })
      .then((data) => {
        setHasPendingApprovals((data?.pendingLeaveApprovals ?? 0) > 0)
      })
      .catch(() => null)

    return () => controller.abort()
  }, [role, items])

  // Employees only see "My Leave" — no reason to render a single-tab
  // navigation.
  if (items.length <= 1) return null

  // Longest-matching-prefix wins. Prevents "My Leave" (href
  // /employee/leave) from lighting up alongside "Approvals" (href
  // /employee/leave/approvals) — a naive startsWith check made the
  // parent index match any nested route.
  const activeHref = items
    .map((item) => item.href)
    .filter(
      (href) => pathname === href || pathname.startsWith(href + "/"),
    )
    .sort((a, b) => b.length - a.length)[0]

  return (
    <nav className="lg:hidden mb-4 overflow-x-auto no-scrollbar">
      <div className="flex gap-2">
        {items.map((item) => {
          const active = item.href === activeHref
          const showDot =
            item.href === APPROVALS_HREF && hasPendingApprovals
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              {showDot ? (
                <span
                  aria-label="pending"
                  className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive shadow-[0_0_0_2px_hsl(var(--card))]"
                />
              ) : null}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
