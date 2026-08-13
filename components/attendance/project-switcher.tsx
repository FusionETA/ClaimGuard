"use client"

import { useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { ChevronLeft, ChevronRight } from "lucide-react"

/**
 * Compact ◄ Project ► stepper for the supervisor Team view. Cycles the
 * `${prefix}Project` URL param through [All projects, ...projects] and
 * pushes it (same mechanism as the table's filter bar) so the server
 * re-renders the scoped roll-call. Renders nothing when the team spans
 * ≤ 1 project (nothing to switch between).
 */
export function ProjectSwitcher({
  prefix,
  projects,
  value,
}: {
  prefix: string
  projects: Array<{ id: string; name: string }>
  /// Current projectId from the URL, or null for "All projects".
  value: string | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const options = [{ id: "", name: "All projects" }, ...projects]
  if (options.length <= 1) return null

  const currentIdx = Math.max(
    0,
    options.findIndex((o) => o.id === (value ?? "")),
  )
  const current = options[currentIdx]

  function go(delta: number) {
    const next = options[(currentIdx + delta + options.length) % options.length]
    const params = new URLSearchParams(searchParams.toString())
    if (next.id) params.set(`${prefix}Project`, next.id)
    else params.delete(`${prefix}Project`)
    // Reset the team filter — a team from the previous project would show
    // nothing under the new one.
    params.delete(`${prefix}Team`)
    const qs = params.toString()
    const href = (qs ? `${pathname}?${qs}` : pathname) as never
    startTransition(() => router.push(href, { scroll: false }))
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-2xl border border-border/60 bg-surface-low px-2 py-1.5">
      <button
        type="button"
        onClick={() => go(-1)}
        disabled={pending}
        aria-label="Previous project"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:opacity-50"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div className="min-w-0 text-center">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Project {currentIdx + 1} / {options.length}
        </p>
        <p className="truncate text-sm font-semibold text-foreground">
          {current.name}
        </p>
      </div>
      <button
        type="button"
        onClick={() => go(1)}
        disabled={pending}
        aria-label="Next project"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:opacity-50"
      >
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  )
}
