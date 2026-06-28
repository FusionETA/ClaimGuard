"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import type { Route } from "next"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

export type TeamDirectoryGroup = "clocked_in" | "on_leave" | "not_clocked_in"

export type TeamDirectoryItem = {
  employeeId: string
  name: string
  initials: string
  group: TeamDirectoryGroup
  subtitle: string
}

// Sort priority — clocked-in on top, not-clocked-in last.
const ORDER: Record<TeamDirectoryGroup, number> = {
  clocked_in: 0,
  on_leave: 1,
  not_clocked_in: 2,
}

const FILTERS: { key: "all" | TeamDirectoryGroup; label: string }[] = [
  { key: "all", label: "All" },
  { key: "clocked_in", label: "Clocked in" },
  { key: "on_leave", label: "On leave" },
  { key: "not_clocked_in", label: "Not clocked in" },
]

export function TeamDirectory({ items }: { items: TeamDirectoryItem[] }) {
  const [filter, setFilter] = useState<"all" | TeamDirectoryGroup>("all")

  const counts = useMemo(() => {
    const c = { all: items.length, clocked_in: 0, on_leave: 0, not_clocked_in: 0 }
    for (const m of items) c[m.group] += 1
    return c
  }, [items])

  const visible = useMemo(() => {
    const filtered =
      filter === "all" ? items : items.filter((m) => m.group === filter)
    return [...filtered].sort((a, b) => ORDER[a.group] - ORDER[b.group])
  }, [items, filter])

  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No reports assigned. Add team members under{" "}
        <span className="font-semibold">Hierarchy</span> to see them here.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const n = f.key === "all" ? counts.all : counts[f.key]
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === f.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label} · {n}
            </button>
          )
        })}
      </div>
      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No team members match this filter.
        </p>
      ) : (
        <div className="space-y-1">
          {visible.map((m) => (
            <Link
              key={m.employeeId}
              href={`/employee/attendance/team/${m.employeeId}` as Route}
              className="flex items-center gap-3 rounded-xl border border-transparent px-2 py-2 transition hover:border-border/60 hover:bg-secondary/30"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{m.name}</p>
                <p className="text-xs text-muted-foreground">{m.subtitle}</p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
