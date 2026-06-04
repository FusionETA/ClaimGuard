import "server-only"

import { bustPayrollCaches } from "@/lib/cache-invalidation"
import {
  getXeroAccounts,
  getXeroRuntimeConfigStatus,
  getXeroTrackingCategories,
  refreshXeroToken,
  type XeroTrackingCategory,
} from "@/lib/xero"
import { safeErrorMessage } from "@/lib/errors"
import type {
  ChartOfAccountOption,
  OrganizationProjectOption,
  OrganizationSummary,
  XeroConnectionSummary,
} from "@/modules/organization/domain/models"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

export type XeroSyncResult =
  | {
      status: "synced"
      message: string
    }
  | {
      status: "skipped"
      message: string
    }
  | {
      status: "error"
      message: string
    }

function trimErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Xero error."
}

export async function getUsableXeroAccessToken(connectionId: string) {
  const connection = await organizationRepository.getXeroConnectionById(connectionId)

  if (!connection) {
    return null
  }

  const expiresSoon = connection.accessTokenExpiresAt.getTime() <= Date.now() + 60_000

  if (!expiresSoon) {
    return {
      accessToken: connection.accessToken,
      tenantId: connection.tenantId,
    }
  }

  // Token is expiring — try to refresh it.
  // We use optimistic locking: only write back if no other concurrent request has already
  // refreshed (i.e. the refresh token in DB still matches what we read).
  try {
    const refreshed = await refreshXeroToken(connection.refreshToken)

    await organizationRepository.updateXeroConnectionTokensIfMatch({
      connectionId: connection.id,
      oldRefreshToken: connection.refreshToken,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      scope: refreshed.scope,
      tokenType: refreshed.tokenType,
      accessTokenExpiresAt: refreshed.expiresAt,
    })

    return {
      accessToken: refreshed.accessToken,
      tenantId: connection.tenantId,
    }
  } catch {
    // The refresh failed. This is EITHER benign (a concurrent request already
    // rotated the refresh token, so ours was stale) OR terminal (the refresh
    // token / OAuth grant is dead — e.g. the org was disconnected on Xero's
    // side). We re-read the row to tell them apart:
    //   • If another request stored a *different, still-valid* token, use it.
    //   • Otherwise the connection genuinely needs re-authorisation. Return
    //     null so callers report "reconnect Xero" instead of handing back an
    //     expired token that Xero rejects with a confusing 403
    //     "AuthenticationUnsuccessful".
    const fresh = await organizationRepository.getXeroConnectionById(connectionId)
    if (!fresh) return null

    const tokenWasRotatedByOther = fresh.refreshToken !== connection.refreshToken
    const stillValid = fresh.accessTokenExpiresAt.getTime() > Date.now() + 60_000

    if (tokenWasRotatedByOther && stillValid) {
      return {
        accessToken: fresh.accessToken,
        tenantId: fresh.tenantId,
      }
    }

    return null
  }
}

export async function getXeroConnectionSummary(
  organizationId?: string
): Promise<XeroConnectionSummary> {
  const runtime = getXeroRuntimeConfigStatus()

  if (!organizationId) {
    return {
      configured: runtime.configured,
      missingConfig: runtime.missing,
      connections: [],
    }
  }

  const stored = await organizationRepository.getXeroConnectionSummary(organizationId)

  return {
    configured: runtime.configured,
    missingConfig: runtime.missing,
    connections: stored?.connections ?? [],
  }
}

export async function getAdminOrganizationSummary(
  organizationId?: string
): Promise<OrganizationSummary | undefined> {
  if (!organizationId) {
    return undefined
  }

  return (await organizationRepository.getOrganizationById(organizationId)) ?? undefined
}

export async function syncOrganizationChartAccounts(
  connectionId: string
): Promise<{
  ok: boolean
  message: string
  accounts?: ChartOfAccountOption[]
}> {
  const runtime = getXeroRuntimeConfigStatus()

  if (!runtime.configured) {
    return {
      ok: false,
      message: `Xero sync is not ready. Missing config: ${runtime.missing.join(", ")}.`,
    }
  }

  const connection = await getUsableXeroAccessToken(connectionId)

  if (!connection) {
    return {
      ok: false,
      message: "Connect Xero for this organization before importing accounts.",
    }
  }

  // Need the full connection record to get organizationId
  const connectionRecord = await organizationRepository.getXeroConnectionById(connectionId)
  if (!connectionRecord) {
    return { ok: false, message: "Xero connection not found." }
  }

  try {
    // Pull EXPENSE + BANK + every LIABILITY-style account type so the
    // payroll Xero-mapping settings can point accrual lines (EPF /
    // SOCSO / EIS / PCB / Salary payable) at the right liability
    // accounts. `LIABILITY` is the legacy type code; modern Xero
    // splits this into `CURRLIAB` (current) and `TERMLIAB`
    // (long-term/non-current). We include all three to be safe across
    // tenant configurations.
    const accounts = await getXeroAccounts({
      accessToken: connection.accessToken,
      tenantId: connection.tenantId,
      includeTypes: [
        "EXPENSE",
        "BANK",
        "LIABILITY",
        "CURRLIAB",
        "TERMLIAB",
      ],
    })

    await organizationRepository.upsertChartAccountsFromXero({
      xeroConnectionId: connectionId,
      organizationId: connectionRecord.organizationId,
      accounts,
    })

    const stored = await organizationRepository.getChartAccountsForConnection(connectionId)

    return {
      ok: true,
      message: `Imported ${accounts.length} Xero accounts for this connection.`,
      accounts: stored,
    }
  } catch (error) {
    return {
      ok: false,
      message: `Unable to import Xero accounts right now: ${trimErrorMessage(error)}`,
    }
  }
}

/**
 * Pull the active options from the picked Xero Tracking Category and
 * upsert each as a XeroProject row. Treats each tracking option as
 * "a project" — keeps the same DB shape (and same FKs on Claim /
 * AttendanceRecord) so the rest of the app keeps working without
 * caring whether the underlying record came from the old Projects API
 * or the new Tracking Category sync.
 *
 * Pre-condition: the admin has picked a tracking category in settings
 * (`XeroConnection.xeroTrackingCategoryId` is set). If not, this
 * returns a friendly error pointing them to the picker.
 *
 * Legacy `XeroProject` rows (from the old `/Projects` API sync) stay
 * untouched — they coexist with new tracking-option rows in the same
 * table. Existing claims/attendance FKs continue to point at the
 * legacy rows.
 */
export async function syncOrganizationProjects(
  connectionId: string
): Promise<{
  ok: boolean
  message: string
  projects?: OrganizationProjectOption[]
}> {
  const runtime = getXeroRuntimeConfigStatus()

  if (!runtime.configured) {
    return {
      ok: false,
      message: `Xero sync is not ready. Missing config: ${runtime.missing.join(", ")}.`,
    }
  }

  const connection = await getUsableXeroAccessToken(connectionId)

  if (!connection) {
    return {
      ok: false,
      message: "Connect Xero for this organization before importing projects.",
    }
  }

  const connectionRecord = await organizationRepository.getXeroConnectionById(connectionId)
  if (!connectionRecord) {
    return { ok: false, message: "Xero connection not found." }
  }

  if (!connectionRecord.xeroTrackingCategoryId) {
    return {
      ok: false,
      message:
        "Pick a Xero Tracking Category in Settings before syncing projects.",
    }
  }

  try {
    const categories = await getXeroTrackingCategories({
      accessToken: connection.accessToken,
      tenantId: connection.tenantId,
    })
    const picked = categories.find(
      (c) => c.xeroTrackingCategoryId === connectionRecord.xeroTrackingCategoryId,
    )
    if (!picked) {
      return {
        ok: false,
        message:
          "The tracking category linked to this connection no longer exists in Xero (it may have been archived or deleted). Pick a different one in Settings.",
      }
    }

    // Refresh the cached name in case the admin renamed the category
    // in Xero since the last sync.
    if (picked.name !== connectionRecord.xeroTrackingCategoryName) {
      await organizationRepository.setXeroTrackingCategory({
        connectionId,
        xeroTrackingCategoryId: picked.xeroTrackingCategoryId,
        xeroTrackingCategoryName: picked.name,
      })
    }

    await organizationRepository.upsertTrackingOptionsFromXero({
      xeroConnectionId: connectionId,
      organizationId: connectionRecord.organizationId,
      options: picked.options.map((o) => ({
        xeroTrackingOptionId: o.xeroTrackingOptionId,
        name: o.name,
        status: o.status,
      })),
    })

    const stored = await organizationRepository.getProjectsForConnection(connectionId)

    return {
      ok: true,
      message: `Imported ${picked.options.length} options from "${picked.name}".`,
      projects: stored,
    }
  } catch (error) {
    return {
      ok: false,
      message: `Unable to import projects right now: ${trimErrorMessage(error)}`,
    }
  }
}

/**
 * Lists the connection's active Xero tracking categories for the
 * settings picker. Live read from Xero — categories change rarely so
 * the round-trip is fine on a settings page load. Returns the
 * full XeroTrackingCategory shape including each category's options
 * (used to preview the # of options in the picker).
 */
export async function listXeroTrackingCategoriesForConnection(
  connectionId: string,
): Promise<{
  ok: boolean
  message?: string
  categories?: XeroTrackingCategory[]
}> {
  const runtime = getXeroRuntimeConfigStatus()
  if (!runtime.configured) {
    return {
      ok: false,
      message: `Xero is not configured. Missing: ${runtime.missing.join(", ")}.`,
    }
  }

  const connection = await getUsableXeroAccessToken(connectionId)
  if (!connection) {
    return { ok: false, message: "Xero connection not found or expired." }
  }

  try {
    const categories = await getXeroTrackingCategories({
      accessToken: connection.accessToken,
      tenantId: connection.tenantId,
    })
    return { ok: true, categories }
  } catch (error) {
    return {
      ok: false,
      message: `Unable to read Xero tracking categories: ${trimErrorMessage(error)}`,
    }
  }
}

/**
 * Persist the admin's tracking-category pick on the connection.
 * Doesn't trigger a sync — the admin separately clicks "Sync now" or
 * waits for the next scheduled sync. We DO live-validate the ID
 * against Xero to make sure the admin can't save a stale GUID; if
 * Xero doesn't return the category we refuse the write.
 *
 * Passing `null` clears the pick (and effectively disables further
 * project sync until a new pick is made).
 */
export async function setXeroTrackingCategoryForConnection(input: {
  connectionId: string
  xeroTrackingCategoryId: string | null
}): Promise<{ ok: boolean; message?: string; name?: string | null }> {
  if (input.xeroTrackingCategoryId === null) {
    await organizationRepository.setXeroTrackingCategory({
      connectionId: input.connectionId,
      xeroTrackingCategoryId: null,
      xeroTrackingCategoryName: null,
    })
    return { ok: true, name: null }
  }

  const live = await listXeroTrackingCategoriesForConnection(input.connectionId)
  if (!live.ok || !live.categories) {
    return { ok: false, message: live.message ?? "Could not validate pick." }
  }

  const picked = live.categories.find(
    (c) => c.xeroTrackingCategoryId === input.xeroTrackingCategoryId,
  )
  if (!picked) {
    return {
      ok: false,
      message:
        "That tracking category doesn't exist in Xero anymore. Pick a different one.",
    }
  }

  await organizationRepository.setXeroTrackingCategory({
    connectionId: input.connectionId,
    xeroTrackingCategoryId: picked.xeroTrackingCategoryId,
    xeroTrackingCategoryName: picked.name,
  })
  return { ok: true, name: picked.name }
}

export async function disconnectXeroConnection(data: {
  connectionId: string
  organizationId: string
}): Promise<{ ok: boolean; message: string }> {
  const connection = await organizationRepository.getXeroConnectionById(data.connectionId)

  if (!connection || connection.organizationId !== data.organizationId) {
    return { ok: false, message: "Xero connection not found." }
  }

  // Best-effort: revoke on Xero's side so the token is invalidated AND
  // the entry disappears from the user's Xero "Connected apps" list.
  //
  // The DELETE endpoint expects Xero's connection ID, NOT the tenant ID
  // — these are different GUIDs. Older rows predate the
  // `xeroConnectionId` column and need a runtime GET /connections
  // lookup to resolve it; new rows have it stored at connect time.
  // When the lookup fails (revoked token, network), we still proceed
  // with the local delete so the UI doesn't get stuck.
  try {
    const { deleteXeroConnection: revokeOnXero, findXeroConnectionIdForTenant } =
      await import("@/lib/xero")
    const xeroConnId =
      connection.xeroConnectionId ??
      (await findXeroConnectionIdForTenant(connection.accessToken, connection.tenantId))
    if (xeroConnId) {
      await revokeOnXero(connection.accessToken, xeroConnId)
    }
  } catch {
    // Non-fatal — continue to delete locally even if Xero revocation fails
  }

  const deleted = await organizationRepository.deleteXeroConnection({
    connectionId: data.connectionId,
    organizationId: data.organizationId,
  })

  if (!deleted) {
    return { ok: false, message: "Failed to disconnect Xero." }
  }

  return { ok: true, message: "Xero connection disconnected." }
}

/**
 * Sync a single claim to Xero. For PERSONAL-money claims this creates an
 * ACCPAY Invoice (Bill); the admin chooses whether it lands as a Draft
 * or directly as Awaiting Payment via `billStatus`. COMPANY-money claims
 * always create a Spend Money txn (Xero has no draft equivalent there).
 *
 * `billStatus` defaults to `AUTHORISED` so older callers (and any
 * unit-test fixtures) keep the existing behaviour.
 */
export async function syncApprovedClaimToXero(
  claimId: string,
  opts?: { billStatus?: "DRAFT" | "AUTHORISED" },
): Promise<XeroSyncResult> {
  const runtime = getXeroRuntimeConfigStatus()

  if (!runtime.configured) {
    return {
      status: "skipped",
      message: `Xero sync skipped. Missing config: ${runtime.missing.join(", ")}.`,
    }
  }

  const claim = await claimRepository.getClaimForXeroSync(claimId)

  if (!claim) {
    return {
      status: "error",
      message: "Xero sync failed because the approved claim could not be found.",
    }
  }

  const failClaimSync = async (message: string): Promise<XeroSyncResult> => {
    await claimRepository
      .markClaimXeroError({
        claimId: claim.id,
        message,
      })
      .catch(() => undefined)
    return { status: "error", message }
  }

  const isCompanyMoney = claim.paymentType === "COMPANY"

  // Idempotency: skip if this claim has already been posted on its path.
  if (!isCompanyMoney && claim.xeroBillId) {
    return {
      status: "skipped",
      message: "Xero bill already exists for this claim.",
    }
  }
  if (isCompanyMoney && claim.xeroSpendMoneyId) {
    return {
      status: "skipped",
      message: "Xero spend-money transaction already exists for this claim.",
    }
  }

  // COMPANY-money claims post as a Spend Money bank transaction and need
  // the "paid from" bank account the claimant selected at submission.
  if (isCompanyMoney) {
    const bankCode = claim.payViaBankAccount?.code ?? null
    if (!bankCode) {
      return failClaimSync(
        "Company-money claim has no Xero-linked bank account to pay from. Re-check the claim's 'pay via' account.",
      )
    }
  }

  // The claim's expense account must be linked to a Xero connection.
  // Custom (non-Xero) accounts can't produce a bill — surface a clear
  // error so the admin knows to either pick a different account or
  // mark the claim paid manually.
  const xeroConnectionId = claim.chartOfAccount?.xeroConnectionId ?? null
  const xeroAccountCode = claim.chartOfAccount?.code ?? null
  if (!xeroConnectionId || !xeroAccountCode) {
    return failClaimSync(
      "Claim's expense account isn't linked to Xero. Pick a Xero-linked account before syncing.",
    )
  }

  const connection = await getUsableXeroAccessToken(xeroConnectionId)
  if (!connection) {
    return failClaimSync(
      "Xero connection unavailable. Reconnect Xero in Settings -> Integrations.",
    )
  }

  // Resolve the Xero Tracking Category used for claim projects. The
  // org-level Xero connection is the source of truth because that same
  // pick drives the claim/attendance project list. Payroll's mapping is
  // retained as a fallback for older data where only payroll settings
  // had a tracking category selected.
  let trackingCategoryName: string | null = null
  let trackingOptions: Set<string> | null = null
  if (claim.organizationId && claim.project?.name) {
    const connectionRecord =
      await organizationRepository.getXeroConnectionById(xeroConnectionId)
    let trackingCategoryId = connectionRecord?.xeroTrackingCategoryId ?? null

    if (!trackingCategoryId) {
      const { payrollSettingsRepository } = await import(
        "@/modules/payroll/infrastructure/payroll-settings.repository"
      )
      const settings = await payrollSettingsRepository.getByOrgId(
        claim.organizationId,
      )
      trackingCategoryId = settings?.xeroMapping?.trackingCategoryId ?? null
    }

    if (trackingCategoryId) {
      // Look up the tracking category's NAME (Xero's bill API needs
      // the category Name + option Name, not their IDs).
      try {
        const { getXeroTrackingCategories } = await import("@/lib/xero")
        const cats = await getXeroTrackingCategories({
          accessToken: connection.accessToken,
          tenantId: connection.tenantId,
        })
        const cat = cats.find(
          (c) => c.xeroTrackingCategoryId === trackingCategoryId,
        )
        if (cat) {
          trackingCategoryName = cat.name
          trackingOptions = new Set(cat.options.map((option) => option.name))
        }
      } catch (err) {
        // Non-fatal: bill still posts, just without tracking.
        console.warn("[xero-sync] tracking category lookup failed:", err)
      }
    }
  }

  // Project tracking dimension, shared by both paths.
  const tracking =
    trackingCategoryName &&
    claim.project?.name &&
    trackingOptions?.has(claim.project.name)
      ? [{ name: trackingCategoryName, option: claim.project.name }]
      : undefined

  try {
    const fmt = (d: Date) => d.toISOString().slice(0, 10)
    const today = new Date()

    // ── COMPANY money → Spend Money bank transaction ────────────────
    if (isCompanyMoney) {
      const { createXeroSpendMoney, associateFileWithObject } = await import(
        "@/lib/xero"
      )
      const txn = await createXeroSpendMoney({
        accessToken: connection.accessToken,
        tenantId: connection.tenantId,
        idempotencyKey: `claim-spend-${claim.id}`,
        payload: {
          contactName: claim.employee.name,
          contactEmail: claim.employee.email,
          date: fmt(today),
          currency: claim.currency,
          amount: claim.amount,
          description: `${claim.claimNumber} — ${claim.title}`,
          reference: claim.claimNumber,
          accountCode: xeroAccountCode,
          // Guaranteed present — checked above for COMPANY claims.
          bankAccountCode: claim.payViaBankAccount!.code,
          tracking,
        },
      })

      await claimRepository.markClaimSpendMoneySynced({
        claimId: claim.id,
        xeroSpendMoneyId: txn.bankTransactionId,
        xeroSpendMoneyRef: txn.reference,
      })
      if (claim.organizationId) {
        await bustPayrollCaches({ organizationId: claim.organizationId })
      }

      if (claim.xeroFileId) {
        try {
          await associateFileWithObject({
            accessToken: connection.accessToken,
            tenantId: connection.tenantId,
            fileId: claim.xeroFileId,
            objectId: txn.bankTransactionId,
            objectGroup: "BankTransaction",
          })
        } catch (err) {
          console.warn("[xero-sync] receipt attach failed:", err)
        }
      }

      return {
        status: "synced",
        message: `Spend Money ${txn.reference ?? txn.bankTransactionId} created in Xero.`,
      }
    }

    // ── PERSONAL money → awaiting-payment bill (unchanged) ──────────
    const { createXeroBill, associateFileWithInvoice } = await import(
      "@/lib/xero"
    )
    const dueDate = new Date(today)
    dueDate.setDate(dueDate.getDate() + 30) // 30-day default term

    const bill = await createXeroBill({
      accessToken: connection.accessToken,
      tenantId: connection.tenantId,
      idempotencyKey: `claim-${claim.id}`,
      status: opts?.billStatus ?? "AUTHORISED",
      payload: {
        contactName: claim.employee.name,
        contactEmail: claim.employee.email,
        date: fmt(today),
        dueDate: fmt(dueDate),
        currency: claim.currency,
        amount: claim.amount,
        description: `${claim.claimNumber} — ${claim.title}`,
        reference: claim.claimNumber,
        accountCode: xeroAccountCode,
        tracking,
      },
    })

    // Persist the bill IDs so we never double-post.
    await claimRepository.markClaimXeroSynced({
      claimId: claim.id,
      xeroBillId: bill.invoiceId,
      xeroBillRef: bill.invoiceNumber,
    })
    if (claim.organizationId) {
      await bustPayrollCaches({ organizationId: claim.organizationId })
    }

    // Best-effort: attach the receipt to the bill in Xero so it
    // shows up in the bill's Files panel.
    if (claim.xeroFileId) {
      try {
        await associateFileWithInvoice({
          accessToken: connection.accessToken,
          tenantId: connection.tenantId,
          fileId: claim.xeroFileId,
          invoiceId: bill.invoiceId,
        })
      } catch (err) {
        console.warn("[xero-sync] receipt attach failed:", err)
      }
    }

    return {
      status: "synced",
      message: `Bill ${bill.invoiceNumber ?? bill.invoiceId} created in Xero.`,
    }
  } catch (err) {
    return failClaimSync(safeErrorMessage(err, "Xero sync failed."))
  }
}
