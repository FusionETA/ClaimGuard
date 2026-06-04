"use server"

import { revalidatePath } from "next/cache"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { bustClaimCaches } from "@/lib/cache-invalidation"
import { safeErrorMessage } from "@/lib/errors"
import { attachClaimToPayrollRun } from "@/modules/payroll/application/services/payroll-run.service"
import { syncApprovedClaimToXero } from "@/modules/organization/application/services/xero-connection.service"

export type BulkActionResult = {
  ok: boolean
  message: string
  succeeded: number
  failed: number
}

async function requireAdmin(): Promise<
  | { ok: true; organizationId: string }
  | { ok: false; message: string }
> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { ok: false, message: "No organization selected." }
  }
  return { ok: true, organizationId }
}

/**
 * Bulk-attach the selected PERSONAL claims to a DRAFT payroll run. Each
 * becomes a REIMBURSEMENT line on the run and is paid out via payroll
 * (no Xero bill). Per-claim failures are tallied; the rest still attach.
 */
export async function bulkAttachClaimsToRunAction(
  runId: string,
  claimIds: string[],
): Promise<BulkActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, message: auth.message, succeeded: 0, failed: 0 }
  if (!runId) {
    return { ok: false, message: "Pick a draft payroll run first.", succeeded: 0, failed: 0 }
  }
  if (claimIds.length === 0) {
    return { ok: false, message: "No claims selected.", succeeded: 0, failed: 0 }
  }

  const outcomes = await Promise.allSettled(
    claimIds.map((claimId) => attachClaimToPayrollRun({ runId, claimId })),
  )
  const succeeded = outcomes.filter((o) => o.status === "fulfilled").length
  const failed = outcomes.length - succeeded

  await bustClaimCaches({ organizationId: auth.organizationId })
  revalidatePath("/admin/claims/payroll-ready")
  revalidatePath(`/admin/payroll/runs/${runId}`)

  return {
    ok: failed === 0,
    succeeded,
    failed,
    message:
      failed === 0
        ? `Added ${succeeded} claim${succeeded === 1 ? "" : "s"} to the payroll run.`
        : `${succeeded} added, ${failed} failed. Check the failed claims and retry.`,
  }
}

/**
 * Bulk-sync the selected claims to Xero. The underlying sync auto-routes
 * by payment type: PERSONAL → awaiting-payment bill, COMPANY → Spend
 * Money bank transaction. Per-claim failures are tallied. Only callable
 * when the org has a Xero connection (UI gates this).
 */
export async function bulkSyncClaimsToXeroAction(
  claimIds: string[],
  billStatus: "DRAFT" | "AUTHORISED" = "AUTHORISED",
): Promise<BulkActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, message: auth.message, succeeded: 0, failed: 0 }
  if (claimIds.length === 0) {
    return { ok: false, message: "No claims selected.", succeeded: 0, failed: 0 }
  }
  // Defensive narrow — the action is invoked via `useTransition` from a
  // controlled <Select>, but it's still a server-action boundary that
  // anyone can call.
  const safeStatus: "DRAFT" | "AUTHORISED" =
    billStatus === "DRAFT" ? "DRAFT" : "AUTHORISED"

  let succeeded = 0
  let failed = 0
  const errors: string[] = []

  const outcomes = await Promise.allSettled(
    claimIds.map((claimId) =>
      syncApprovedClaimToXero(claimId, { billStatus: safeStatus }),
    ),
  )
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled" && outcome.value.status === "synced") {
      succeeded += 1
    } else {
      failed += 1
      if (outcome.status === "fulfilled" && outcome.value.status === "error") {
        errors.push(outcome.value.message)
      } else if (outcome.status === "rejected") {
        errors.push(safeErrorMessage(outcome.reason, "Sync failed."))
      }
    }
  }

  await bustClaimCaches({ organizationId: auth.organizationId })
  revalidatePath("/admin/claims/payroll-ready")

  return {
    ok: failed === 0,
    succeeded,
    failed,
    message:
      failed === 0
        ? `Synced ${succeeded} claim${succeeded === 1 ? "" : "s"} to Xero.`
        : `${succeeded} synced, ${failed} failed${errors.length ? `: ${errors[0]}` : "."}`,
  }
}
