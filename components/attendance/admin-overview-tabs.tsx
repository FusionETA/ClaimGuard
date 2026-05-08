"use client"

import { useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

type TabKey = "today" | "trends"

const TABS: { key: TabKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "trends", label: "Trends" },
]

export function AdminOverviewTabs({
  today,
  trends,
}: {
  today: ReactNode
  trends: ReactNode
}) {
  const [active, setActive] = useState<TabKey>("today")

  return (
    <div className="space-y-6">
      <nav className="-mx-6 overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
      <div className={active === "trends" ? "block space-y-6" : "hidden"}>
        {trends}
      </div>
    </div>
  )
}
