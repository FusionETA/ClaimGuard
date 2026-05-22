"use client"

import Link from "next/link"
import { useMemo, useState, useTransition } from "react"
import { CalendarPlus, CircleCheck, Loader2, Search, Upload } from "lucide-react"

import {
  bulkAttachClaimsToRunAction,
  bulkSyncClaimsToXeroAction,
} from "@/app/(admin)/admin/claims/payroll-ready/actions"
import {
  ClaimDetailSheet,
  ClaimTypeBadge,
  OverLimitBadge,
} from "@/components/admin/claim-row-helpers"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useToast } from "@/components/ui/toaster"
import { cn, formatCurrency, formatShortDate } from "@/lib/utils"
import type { ClaimRecord } from "@/modules/claims/domain/models"
import type { PayrollRunRow } from "@/modules/payroll/domain/runs"

/**
 * Admin "Ready to Pay" page. Lists REVIEWED claims that haven't been
 * paid out yet, split by payment type:
 *
 *   - PERSONAL (employee out of pocket) → bulk "Add to payroll run"
 *     (paid via payroll, posts as a manual-journal reimbursement) OR
 *     bulk "Sync to Xero" (awaiting-payment bill). The Xero option is
 *     hidden when the org isn't connected to Xero.
 *   - COMPANY (paid from a company bank/card) → bulk "Create Spend
 *     Money" (Xero bank transaction). Requires a Xero connection.
 */
export function ClaimPayrollReadyList({
  claims,
  draftRuns,
  xeroConnected,
}: {
  claims: ClaimRecord[]
  draftRuns: PayrollRunRow[]
  xeroConnected: boolean
}) {
  const [searchTerm, setSearchTerm] = useState("")
  const [detailClaim, setDetailClaim] = useState<ClaimRecord | null>(null)

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    if (!q) return claims
    return claims.filter((claim) =>
      [claim.claimNumber, claim.title, claim.employee.name, claim.employee.jobTitle]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    )
  }, [claims, searchTerm])

  const personalClaims = useMemo(
    () => filtered.filter((c) => c.paymentType === "PERSONAL"),
    [filtered],
  )
  const companyClaims = useMemo(
    () => filtered.filter((c) => c.paymentType === "COMPANY"),
    [filtered],
  )

  if (claims.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 p-10 text-center">
          <CircleCheck className="h-8 w-8 text-emerald-500" />
          <p className="font-semibold">All caught up</p>
          <p className="text-sm text-muted-foreground">
            No reviewed claims are waiting to be paid. Approved claims
            appear here once an admin reviews them.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <ClaimDetailSheet
        claim={detailClaim}
        open={detailClaim !== null}
        onClose={() => setDetailClaim(null)}
      />

      <div className="space-y-6">
        <Card>
          <CardContent className="px-5 pb-5 pt-3 sm:p-6">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search by claim or employee"
                className="pl-10"
              />
            </div>
          </CardContent>
        </Card>

        <ClaimGroup
          title="Personal-money claims"
          subtitle="Paid back to the employee — add to a payroll run, or bill in Xero."
          claims={personalClaims}
          mode="PERSONAL"
          draftRuns={draftRuns}
          xeroConnected={xeroConnected}
          onOpenDetail={setDetailClaim}
        />

        <ClaimGroup
          title="Company-money claims"
          subtitle="Already paid from a company account — record as Spend Money in Xero."
          claims={companyClaims}
          mode="COMPANY"
          draftRuns={draftRuns}
          xeroConnected={xeroConnected}
          onOpenDetail={setDetailClaim}
        />
      </div>
    </>
  )
}

function ClaimGroup({
  title,
  subtitle,
  claims,
  mode,
  draftRuns,
  xeroConnected,
  onOpenDetail,
}: {
  title: string
  subtitle: string
  claims: ClaimRecord[]
  mode: "PERSONAL" | "COMPANY"
  draftRuns: PayrollRunRow[]
  xeroConnected: boolean
  onOpenDetail: (claim: ClaimRecord) => void
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedRunId, setSelectedRunId] = useState<string>(draftRuns[0]?.id ?? "")

  const allSelected = claims.length > 0 && selectedIds.size === claims.length
  const selectedCount = selectedIds.size

  function toggleAll() {
    setSelectedIds(allSelected ? new Set() : new Set(claims.map((c) => c.id)))
  }
  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function runBulk(
    fn: () => Promise<{ ok: boolean; message: string }>,
  ) {
    startTransition(async () => {
      const result = await fn()
      toast({ title: result.message, variant: result.ok ? "success" : "error" })
      if (result.ok) setSelectedIds(new Set())
    })
  }

  function handleAddToRun() {
    if (!selectedRunId) {
      toast({ title: "Pick a draft payroll run first.", variant: "error" })
      return
    }
    runBulk(() =>
      bulkAttachClaimsToRunAction(selectedRunId, Array.from(selectedIds)),
    )
  }
  function handleSyncToXero() {
    runBulk(() => bulkSyncClaimsToXeroAction(Array.from(selectedIds)))
  }

  if (claims.length === 0) {
    return (
      <div>
        <SectionHeading title={title} subtitle={subtitle} />
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No {mode === "PERSONAL" ? "personal" : "company"}-money claims waiting.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <SectionHeading title={title} subtitle={subtitle} />

      {/* Bulk action bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
        <span className="text-sm text-muted-foreground">
          {selectedCount > 0
            ? `${selectedCount} selected`
            : "Select claims to act on them"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {mode === "PERSONAL" ? (
            <>
              <Select
                value={selectedRunId}
                onValueChange={setSelectedRunId}
                disabled={draftRuns.length === 0}
              >
                <SelectTrigger className="h-8 w-[170px] text-xs">
                  <SelectValue placeholder="Pick a draft run" />
                </SelectTrigger>
                <SelectContent>
                  {draftRuns.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {runLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                disabled={pending || selectedCount === 0 || draftRuns.length === 0}
                onClick={handleAddToRun}
                className="gap-1.5"
              >
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CalendarPlus className="h-3.5 w-3.5" />
                )}
                Add to payroll
              </Button>
              {xeroConnected ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending || selectedCount === 0}
                  onClick={handleSyncToXero}
                  className="gap-1.5"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Sync to Xero (bill)
                </Button>
              ) : null}
            </>
          ) : xeroConnected ? (
            <Button
              type="button"
              size="sm"
              disabled={pending || selectedCount === 0}
              onClick={handleSyncToXero}
              className="gap-1.5"
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Create Spend Money
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              Connect Xero to record these as Spend Money.
            </span>
          )}
        </div>
      </div>

      {draftRuns.length === 0 && mode === "PERSONAL" ? (
        <Card className="border-amber-300/60 bg-amber-50/40 dark:border-amber-700/40 dark:bg-amber-950/20">
          <CardContent className="p-3 text-xs text-amber-900 dark:text-amber-200">
            No draft payroll run yet. Create one from{" "}
            <Link href="/admin/payroll/runs" className="underline-offset-2 hover:underline">
              Payroll → Runs
            </Link>{" "}
            to add claims to payroll.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer rounded border-input"
                />
              </TableHead>
              <TableHead>Claim</TableHead>
              <TableHead>Employee</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {claims.map((claim) => {
              const selected = selectedIds.has(claim.id)
              return (
                <TableRow
                  key={claim.id}
                  className={cn("cursor-pointer", selected && "bg-muted/50")}
                  onClick={(e) => {
                    const target = e.target as HTMLElement
                    if (target.closest("[data-row-action]")) return
                    onOpenDetail(claim)
                  }}
                >
                  <TableCell data-row-action onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${claim.title}`}
                      checked={selected}
                      onChange={() => toggleOne(claim.id)}
                      className="h-4 w-4 cursor-pointer rounded border-input"
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex flex-col">
                      <span>{claim.title}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {claim.claimNumber}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{claim.employee.name}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {claim.employee.jobTitle}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {claim.spentAt ? formatShortDate(claim.spentAt) : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <ClaimTypeBadge claimType={claim.claimType} />
                      {claim.exceedsLimit ? <OverLimitBadge /> : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatCurrency(claim.amount)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </div>
  )
}

/** Human-readable label for a payroll run row, e.g. "March 2026". */
function runLabel(run: PayrollRunRow): string {
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ]
  return `${monthNames[run.periodMonth - 1]} ${run.periodYear}`
}
