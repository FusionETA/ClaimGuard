"use client"

import type { Route } from "next"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * Mobile-only sub-navigation for supervisors between their own claims
 * (/employee/claims) and the review queue (/employee/review). Mirrors
 * `AttendanceSubNav` — the bottom mobile bar only surfaces the 5
 * primary tabs, so children like "Claims queue" would otherwise be
 * unreachable on mobile. Hidden at lg+ where the sidebar already
 * exposes the child links.
 */
type Props = {
  /// Signed-in user's role. The sub-nav renders only when SUPERVISOR
  /// (the review queue is supervisor-only) so employees don't see a
  /// misleading tab pair. `string` here matches AppRole from
  /// `lib/auth/session.ts` — no import so the client bundle stays
  /// tight.
  role: string
}

const CLAIMS_HREF = "/employee/claims"
const REVIEW_HREF = "/employee/review"

export function ClaimsSubNav({ role }: Props) {
  const pathname = usePathname()
  const [hasPendingApprovals, setHasPendingApprovals] = useState(false)

  useEffect(() => {
    if (role !== "SUPERVISOR") return
    const controller = new AbortController()

    void fetch("/api/employee/context", {
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return null
        return response.json() as Promise<{ pendingClaimApprovals?: number }>
      })
      .then((data) => {
        setHasPendingApprovals((data?.pendingClaimApprovals ?? 0) > 0)
      })
      .catch(() => null)

    return () => controller.abort()
  }, [role])

  if (role !== "SUPERVISOR") return null

  const items: Array<{ href: Route; label: string; showDot: boolean }> = [
    { href: CLAIMS_HREF as Route, label: "My claims", showDot: false },
    {
      href: REVIEW_HREF as Route,
      label: "Claims queue",
      showDot: hasPendingApprovals,
    },
  ]

  return (
    <nav className="lg:hidden mb-4 overflow-x-auto no-scrollbar">
      <div className="flex gap-2">
        {items.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/")
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
              {item.showDot ? (
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
