"use client"

import { useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PaginationControls } from "@/components/ui/pagination-controls"

import { enterSupportModeAction } from "./actions"

const PAGE_SIZE = 10

type OrgOption = {
  id: string
  name: string
  plan: string
  tier: string | null
  ownerEmail: string | null
  employeeCount: number
}

export function SupportPicker({ orgs }: { orgs: OrgOption[] }) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return orgs
    return orgs.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        (o.ownerEmail ?? "").toLowerCase().includes(q),
    )
  }, [orgs, query])

  // Clamp page when filter tightens the list below current cursor —
  // else user lands on a blank tail page after typing a narrow query.
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pagedOrgs = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label
          htmlFor="support-search"
          className="text-xs font-medium text-muted-foreground"
        >
          Search by org name or owner email
        </label>
        <Input
          id="support-search"
          type="text"
          placeholder="e.g. Kay Ben, ABM, simon@…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            // Reset to page 1 on every keystroke so the visible page
            // always reflects the top of the new filter set.
            setPage(1)
          }}
          autoComplete="off"
        />
        <p className="text-[11px] text-muted-foreground">
          {filtered.length} of {orgs.length} orgs match.
        </p>
      </div>

      <div className="space-y-2">
        {filtered.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No orgs match &quot;{query}&quot;.
            </CardContent>
          </Card>
        ) : (
          <>
            {pagedOrgs.map((org) => (
              <Card key={org.id}>
                <CardContent className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{org.name}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {org.plan}
                        {org.tier ? ` · ${org.tier}` : ""}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {org.ownerEmail ?? "(no owner recorded)"} ·{" "}
                      {org.employeeCount} employee
                      {org.employeeCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <form action={enterSupportModeAction}>
                    <input
                      type="hidden"
                      name="organizationId"
                      value={org.id}
                    />
                    <Button type="submit" size="sm">
                      Enter as support
                    </Button>
                  </form>
                </CardContent>
              </Card>
            ))}
            <PaginationControls
              className="flex flex-wrap items-center justify-between gap-3 pt-2"
              currentPage={currentPage}
              pageSize={PAGE_SIZE}
              totalItems={filtered.length}
              itemLabel="orgs"
              onPageChange={setPage}
            />
          </>
        )}
      </div>
    </div>
  )
}
