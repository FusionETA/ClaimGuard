"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { PaginationControls } from "@/components/ui/pagination-controls"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/toaster"

import { enterSupportModeAction, updateOrgPlanAction } from "./actions"

const PAGE_SIZE = 10

type OrgOption = {
  id: string
  name: string
  plan: string
  tier: string | null
  addons: string[]
  ownerEmail: string | null
  employeeCount: number
}

export function SupportPicker({ orgs }: { orgs: OrgOption[] }) {
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [editingOrg, setEditingOrg] = useState<OrgOption | null>(null)
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

      <div className="space-y-3">
        {filtered.length === 0 ? (
          <p className="rounded-md border border-border/40 py-8 text-center text-sm text-muted-foreground">
            No orgs match &quot;{query}&quot;.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border border-border/40">
              <table className="w-full min-w-[780px] text-sm">
                <thead className="bg-card">
                  <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pl-3 pr-3 font-semibold">Organization</th>
                    <th className="py-2 pr-3 font-semibold">Owner</th>
                    <th className="py-2 pr-3 text-right font-semibold">Employees</th>
                    <th className="py-2 pr-3 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedOrgs.map((org) => (
                    <tr
                      key={org.id}
                      className="border-b border-border/30 last:border-0"
                    >
                      <td className="py-2.5 pl-3 pr-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">
                            {org.name}
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {org.plan}
                            {org.tier ? ` · ${org.tier}` : ""}
                          </Badge>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">
                        {org.ownerEmail ?? "(no owner recorded)"}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                        {org.employeeCount}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingOrg(org)}
                          >
                            Manage plan
                          </Button>
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
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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

      {editingOrg ? (
        <ManagePlanDialog
          org={editingOrg}
          onClose={() => setEditingOrg(null)}
        />
      ) : null}
    </div>
  )
}

/**
 * Superadmin dialog to change a company's package (plan + tier) and toggle
 * the Claims / Attendance add-on modules. Calls `updateOrgPlanAction` and
 * refreshes the table on success.
 */
function ManagePlanDialog({
  org,
  onClose,
}: {
  org: OrgOption
  onClose: () => void
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [plan, setPlan] = useState<"DIY" | "EXPERT">(
    org.plan === "EXPERT" ? "EXPERT" : "DIY",
  )
  const [tier, setTier] = useState<"FREE" | "PAID">(
    org.tier === "PAID" ? "PAID" : "FREE",
  )
  const [claims, setClaims] = useState(org.addons.includes("expense_claim"))
  const [attendance, setAttendance] = useState(org.addons.includes("clock"))

  const freeIgnoresAddons = plan === "DIY" && tier === "FREE"

  function handleSave() {
    startTransition(async () => {
      const result = await updateOrgPlanAction({
        organizationId: org.id,
        plan,
        tier,
        claims,
        attendance,
      })
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
      if (result.ok) {
        onClose()
        // Reflect the new plan / tier badge + add-ons in the table at once.
        router.refresh()
      }
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !pending) onClose()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Manage plan — {org.name}</DialogTitle>
          <DialogDescription>
            Change the subscription package and toggle the Claims / Attendance
            add-on modules for this company.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-semibold text-muted-foreground">
              Package
            </label>
            <Select
              value={plan}
              onValueChange={(v) => setPlan(v === "EXPERT" ? "EXPERT" : "DIY")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DIY">DIY — self-service</SelectItem>
                <SelectItem value="EXPERT">Expert — managed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {plan === "DIY" ? (
            <div className="space-y-1.5">
              <label className="text-sm font-semibold text-muted-foreground">
                Tier
              </label>
              <Select
                value={tier}
                onValueChange={(v) => setTier(v === "PAID" ? "PAID" : "FREE")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FREE">Free</SelectItem>
                  <SelectItem value="PAID">Paid</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-sm font-semibold text-muted-foreground">
              Add-on modules
            </p>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={claims}
                onChange={(e) => setClaims(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Claims
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={attendance}
                onChange={(e) => setAttendance(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Attendance
            </label>
            {freeIgnoresAddons && (claims || attendance) ? (
              <p className="text-[11px] text-tertiary">
                Free tier ignores add-ons — set the tier to Paid (or switch to
                Expert) for Claims / Attendance to actually turn on.
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={pending}>
            {pending ? "Saving…" : "Save plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
