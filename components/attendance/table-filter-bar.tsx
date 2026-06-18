"use client"

import { useEffect, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const ALL = "ALL"

export type TableFilterValue = {
  projectId: string | null
  teamId: string | null
  q: string | null
}

type Props = {
  prefix: string
  projects: Array<{ id: string; name: string }>
  teams: Array<{ id: string; name: string; projectName: string }>
  value: TableFilterValue
  /**
   * When provided, the filter bar calls this instead of pushing to the
   * URL. Useful for client-side panels that manage their own state and
   * call a server action directly (e.g. the history panel).
   */
  onChange?: (next: TableFilterValue) => void
}

export function TableFilterBar({ prefix, projects, teams, value, onChange }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [searchDraft, setSearchDraft] = useState(value.q ?? "")

  const projectKey = `${prefix}Project`
  const teamKey = `${prefix}Team`
  const qKey = `${prefix}Q`

  useEffect(() => {
    setSearchDraft(value.q ?? "")
  }, [value.q])

  function pushParams(mutate: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString())
    mutate(params)
    const qs = params.toString()
    const href = (qs ? `${pathname}?${qs}` : pathname) as never
    startTransition(() => {
      router.push(href, { scroll: false })
    })
  }

  function setProject(next: string) {
    if (onChange) {
      const projectId = next === ALL ? null : next
      const teamId =
        next !== ALL &&
        teams.some((t) => t.id === value.teamId && projects.find((pj) => pj.id === next))
          ? value.teamId
          : null
      onChange({ ...value, projectId, teamId })
      return
    }
    pushParams((p) => {
      if (next === ALL) p.delete(projectKey)
      else p.set(projectKey, next)
      if (next !== ALL) {
        const stillValid = teams.some(
          (t) => t.id === value.teamId && projects.find((pj) => pj.id === next),
        )
        if (!stillValid) p.delete(teamKey)
      }
    })
  }

  function setTeam(next: string) {
    if (onChange) {
      onChange({ ...value, teamId: next === ALL ? null : next })
      return
    }
    pushParams((p) => {
      if (next === ALL) p.delete(teamKey)
      else p.set(teamKey, next)
    })
  }

  function commitSearch(next: string) {
    const trimmed = next.trim() || null
    if (onChange) {
      onChange({ ...value, q: trimmed })
      return
    }
    pushParams((p) => {
      if (!trimmed) p.delete(qKey)
      else p.set(qKey, trimmed)
    })
  }

  const filteredTeams = value.projectId
    ? teams.filter((t) =>
        // We don't have projectId on team option directly here; the page
        // pre-filters to org-wide. Show all teams when no project picked,
        // and let the team option label disambiguate by project.
        teams.some((tt) => tt.id === t.id),
      )
    : teams

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/60 bg-surface-low px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Project
        </span>
        <div className="w-[180px]">
          <Select
            value={value.projectId ?? ALL}
            onValueChange={setProject}
            disabled={pending}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Team
        </span>
        <div className="w-[180px]">
          <Select
            value={value.teamId ?? ALL}
            onValueChange={setTeam}
            disabled={pending || filteredTeams.length === 0}
          >
            <SelectTrigger>
              <SelectValue placeholder="All teams" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All teams</SelectItem>
              {filteredTeams.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.projectName} · {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Employee
        </span>
        <Input
          className="h-9 w-[200px]"
          placeholder="Search by name or email"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onBlur={() => {
            if ((searchDraft || null) !== (value.q || null)) {
              commitSearch(searchDraft)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur()
            }
          }}
          disabled={pending}
        />
      </div>
    </div>
  )
}
