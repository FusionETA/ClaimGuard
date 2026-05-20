"use client"

import { useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

type TabKey = "today" | "analytics" | "performance"

const TABS: { key: TabKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "analytics", label: "Analytics" },
  { key: "performance", label: "Performance" },
]

export function AdminOverviewTabs({
  today,
  analytics,
  performance,
}: {
  today: ReactNode
  analytics: ReactNode
  performance: ReactNode
}) {
  const [active, setActive] = useState<TabKey>("today")

  return (
    <div className="space-y-6">
      <nav className="-mx-6 overflow-x-auto px-6 nice-scrollbar">
        <div className="flex gap-2 pb-0.5">
          {TABS.map((tab) => {
            const isActive = active === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActive(tab.key)}
                className={cn(
                  "shrink-0 rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors",
                  isActive
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
      </nav>
      <div className={active === "today" ? "block space-y-6" : "hidden"}>
        {today}
      </div>
      <div className={active === "analytics" ? "block space-y-6" : "hidden"}>
        {analytics}
      </div>
      <div className={active === "performance" ? "block space-y-6" : "hidden"}>
        {performance}
      </div>
    </div>
  )
}
