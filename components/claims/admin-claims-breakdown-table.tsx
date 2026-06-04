"use client"

import { useState } from "react"

import { ClaimDetailSheet } from "@/components/admin/claim-row-helpers"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn, formatCurrency, formatMonthYear, formatShortDate } from "@/lib/utils"
import type { ClaimRecord } from "@/modules/claims/domain/models"

/**
 * Reports page table body. The breakdown page is a server component but
 * the rows need React state to open the `ClaimDetailSheet` drawer on
 * click, so the table + its row-level badges live here as a client
 * component. The page renders the surrounding chrome (filters, summary
 * stats, pagination) server-side and only delegates this block.
 *
 * Reuses the same `ClaimDetailSheet` the Queue and Ready-to-Pay pages
 * already use — admin gets a consistent drill-down regardless of which
 * tab they came from.
 */
export function AdminClaimsBreakdownTable({ rows }: { rows: ClaimRecord[] }) {
  const [selected, setSelected] = useState<ClaimRecord | null>(null)

  return (
    <>
      <ScrollArea className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-low text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Project</th>
              <th className="px-4 py-3">Claim</th>
              <th className="px-4 py-3">Account</th>
              <th className="px-4 py-3">Spent</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Payroll</th>
              <th className="px-4 py-3">Xero</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  No claims match the current filters.
                </td>
              </tr>
            ) : (
              rows.map((claim) => (
                <tr
                  key={claim.id}
                  // `cursor-pointer` + onClick on the row opens the
                  // detail drawer. The Xero badge intentionally has its
                  // own `<a>` link; clicking it triggers `stopPropagation`
                  // (see XeroBadge below) so the drawer doesn't ALSO
                  // open when the admin wants to jump straight to Xero.
                  className="cursor-pointer border-t border-border/50 hover:bg-surface-low/60"
                  onClick={() => setSelected(claim)}
                >
                  <td className="px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">
                        {claim.employee?.name ?? "—"}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {claim.employee?.email ?? ""}
                      </p>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {claim.employee?.project ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground">{claim.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {claim.claimNumber}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {claim.chartOfAccount
                      ? `${claim.chartOfAccount.code} · ${claim.chartOfAccount.name}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatShortDate(claim.spentAt)}
                  </td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                    {formatCurrency(claim.amount)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={claim.status} />
                  </td>
                  <td className="px-4 py-3">
                    <PayrollBadge attachment={claim.payrollRunAttachment} />
                  </td>
                  <td className="px-4 py-3">
                    <XeroBadge claim={claim} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ScrollArea>

      <ClaimDetailSheet
        claim={selected}
        open={selected != null}
        onClose={() => setSelected(null)}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Row-level badges. Kept in this file (rather than re-imported from the
// server page) so the client bundle has exactly what it needs and the
// page can stay free of "use client" itself.
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "submitted",
  PENDING: "pending",
  APPROVED: "approved",
  PAID: "paid",
  REJECTED: "rejected",
  REVIEWED: "reviewed",
  SETTLED: "settled",
}

const STATUS_BG: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-900",
  SUBMITTED: "bg-amber-100 text-amber-900",
  APPROVED: "bg-emerald-100 text-emerald-900",
  PAID: "bg-emerald-200 text-emerald-950",
  REJECTED: "bg-rose-100 text-rose-900",
  REVIEWED: "bg-sky-100 text-sky-900",
  SETTLED: "bg-emerald-200 text-emerald-950",
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
        STATUS_BG[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {STATUS_LABEL[status] ?? status.toLowerCase()}
    </span>
  )
}

function PayrollBadge({
  attachment,
}: {
  attachment?: {
    periodYear: number
    periodMonth: number
    status: string
  }
}) {
  if (!attachment) {
    return <MutedBadge label="Not included" />
  }
  const period = formatMonthYear(
    new Date(Date.UTC(attachment.periodYear, attachment.periodMonth - 1, 1)),
  )
  return (
    <div className="space-y-1">
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
        Included
      </span>
      <p className="text-xs text-muted-foreground">{period}</p>
    </div>
  )
}

/**
 * Build the deep-link URL for a synced claim. Xero exposes two routes:
 *  - Bill (ACCPAY Invoice) → /AccountsPayable/View.aspx?InvoiceID={guid}
 *  - Spend Money (bank txn) → /BankTransactions/View.aspx?bankTransactionID={guid}
 * Both render the document inside the user's active Xero org login — no
 * tenant id needed in the URL, Xero scopes by their session.
 */
function buildXeroSyncedUrl(claim: {
  xeroBillId?: string
  xeroSpendMoneyId?: string
}): string | null {
  if (claim.xeroSpendMoneyId) {
    return `https://go.xero.com/BankTransactions/View.aspx?bankTransactionID=${claim.xeroSpendMoneyId}`
  }
  if (claim.xeroBillId) {
    return `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${claim.xeroBillId}`
  }
  return null
}

function XeroBadge({
  claim,
}: {
  claim: {
    xeroSyncStatus: "NOT_SYNCED" | "SYNCED" | "ERROR"
    xeroBillId?: string
    xeroSpendMoneyId?: string
    payrollRunAttachment?: {
      xeroSyncStatus: "NOT_SYNCED" | "SYNCED" | "ERROR"
    }
  }
}) {
  if (claim.xeroSyncStatus === "SYNCED") {
    const label = claim.xeroSpendMoneyId
      ? "Spend Money"
      : claim.xeroBillId
        ? "Bill"
        : "Synced"
    const href = buildXeroSyncedUrl(claim)
    if (href) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          // Stop the row's onClick so jumping to Xero doesn't ALSO
          // open the claim detail drawer.
          onClick={(event) => event.stopPropagation()}
          className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900 underline-offset-2 hover:bg-emerald-200 hover:underline"
          title={`Open in Xero (${label})`}
        >
          {label}
        </a>
      )
    }
    return <SuccessBadge label={label} />
  }
  if (claim.payrollRunAttachment?.xeroSyncStatus === "SYNCED") {
    return <SuccessBadge label="Via payroll" />
  }
  if (
    claim.xeroSyncStatus === "ERROR" ||
    claim.payrollRunAttachment?.xeroSyncStatus === "ERROR"
  ) {
    return (
      <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-900">
        Error
      </span>
    )
  }
  if (claim.payrollRunAttachment) {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
        Payroll pending
      </span>
    )
  }
  return <MutedBadge label="Not synced" />
}

function SuccessBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900">
      {label}
    </span>
  )
}

function MutedBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
      {label}
    </span>
  )
}
