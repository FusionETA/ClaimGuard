"use client"

import { useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"

import { enterSupportModeAction } from "./actions"

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
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return orgs
    return orgs.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        (o.ownerEmail ?? "").toLowerCase().includes(q),
    )
  }, [orgs, query])

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
          onChange={(e) => setQuery(e.target.value)}
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
          filtered.map((org) => (
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
          ))
        )}
      </div>
    </div>
  )
}
