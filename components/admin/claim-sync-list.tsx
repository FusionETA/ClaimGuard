"use client"

import { useState, useTransition } from "react"
import { CircleCheck, Loader2, Sparkles } from "lucide-react"

import { syncClaimAction } from "@/app/(admin)/admin/claims/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/toaster"
import { formatCurrency, formatShortDate } from "@/lib/utils"
import type { ClaimRecord } from "@/modules/claims/domain/models"
import type { ChartOfAccountOption } from "@/modules/organization/domain/models"

/**
 * One row per awaiting-sync claim with an editable COA picker + Sync
 * button. Optimistic UX: when Sync is clicked, the row enters a
 * "syncing…" state; on success the page revalidates (server action
 * already calls revalidatePath) and the row disappears from the list.
 *
 * State is local per row — we only POST one claim at a time. Bulk-sync
 * could be a future feature but isn't needed to validate the workflow.
 */
export function ClaimSyncList({
  claims,
  chartAccounts,
}: {
  claims: ClaimRecord[]
  chartAccounts: ChartOfAccountOption[]
}) {
  if (claims.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-2 p-10 text-center">
          <CircleCheck className="h-8 w-8 text-emerald-500" />
          <p className="font-semibold">All caught up</p>
          <p className="text-sm text-muted-foreground">
            No claims are waiting to be synced. Reviewed claims will appear
            here once an admin approves them.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {claims.map((claim) => (
        <SyncRow key={claim.id} claim={claim} chartAccounts={chartAccounts} />
      ))}
    </div>
  )
}

function SyncRow({
  claim,
  chartAccounts,
}: {
  claim: ClaimRecord
  chartAccounts: ChartOfAccountOption[]
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  // Pre-select whatever the claim is currently coded as, so "no change"
  // is the default. Admin only acts if they want to swap it.
  const [coaId, setCoaId] = useState<string>(claim.chartOfAccount?.id ?? "")

  function handleSync() {
    startTransition(async () => {
      const finalCoa =
        coaId && coaId !== claim.chartOfAccount?.id ? coaId : undefined
      const result = await syncClaimAction({
        claimId: claim.id,
        chartOfAccountId: finalCoa,
      })
      if (result.ok) {
        toast({ title: result.message, variant: "success" })
      } else {
        toast({ title: result.message, variant: "error" })
      }
    })
  }

  return (
    <Card>
      <CardContent className="grid gap-4 p-5 lg:grid-cols-[1.4fr_1fr_auto] lg:items-end">
        {/* Claim summary */}
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {claim.claimNumber} · {formatShortDate(claim.spentAt)}
          </p>
          <p className="font-bold text-foreground">{claim.title}</p>
          <p className="text-sm text-muted-foreground">
            {claim.employee.name} · {claim.employee.jobTitle}
          </p>
          <p className="text-lg font-black tabular-nums">
            {formatCurrency(claim.amount)} <span className="text-xs font-medium text-muted-foreground">{claim.currency}</span>
          </p>
          {claim.reviewerName ? (
            <p className="text-xs text-muted-foreground">
              Reviewed by {claim.reviewerName}
              {claim.reviewedAt ? ` on ${formatShortDate(claim.reviewedAt)}` : ""}
            </p>
          ) : null}
        </div>

        {/* COA picker — defaults to current COA, admin can swap before sync */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Chart of account
          </label>
          {chartAccounts.length === 0 ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              No selectable accounts configured.
            </p>
          ) : (
            <Select value={coaId} onValueChange={setCoaId} disabled={pending}>
              <SelectTrigger>
                <SelectValue placeholder="Select chart of account" />
              </SelectTrigger>
              <SelectContent>
                {chartAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {claim.chartOfAccount && coaId && coaId !== claim.chartOfAccount.id ? (
            <p className="text-xs text-amber-700">
              Will be recoded from{" "}
              <span className="font-semibold">
                {claim.chartOfAccount.code} · {claim.chartOfAccount.name}
              </span>
            </p>
          ) : null}
        </div>

        {/* Sync button */}
        <Button
          type="button"
          onClick={handleSync}
          disabled={pending || !coaId}
          className="rounded-xl"
        >
          {pending ? (
            <>
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              Syncing…
            </>
          ) : (
            <>
              <Sparkles className="mr-1.5 h-4 w-4" />
              Sync to Xero
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  )
}
