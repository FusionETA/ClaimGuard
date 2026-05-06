"use client"

import { useRouter } from "next/navigation"
import type { Route } from "next"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/**
 * Month dropdown for the breakdown view. Re-navigates to the same
 * pathname with `?month=yyyy-mm` while preserving the drill-down params
 * (project / team / member). Server component re-runs and re-renders.
 */
export function BreakdownMonthPicker({
  options,
  activeKey,
  carryParams,
}: {
  options: Array<{ key: string; label: string }>
  activeKey: string
  carryParams: { project?: string; team?: string; member?: string }
}) {
  const router = useRouter()

  function handleChange(monthKey: string) {
    const qs = new URLSearchParams()
    if (monthKey) qs.set("month", monthKey)
    if (carryParams.project) qs.set("project", carryParams.project)
    if (carryParams.team) qs.set("team", carryParams.team)
    if (carryParams.member) qs.set("member", carryParams.member)
    const tail = qs.toString()
    // Cast to Route — typed-routes can't statically verify a query string
    // built at runtime, but the base path is a real route.
    const target = (
      tail ? `/admin/claims/breakdown?${tail}` : "/admin/claims/breakdown"
    ) as Route
    router.push(target)
  }

  return (
    <div className="w-full sm:w-56">
      <Select value={activeKey} onValueChange={handleChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
