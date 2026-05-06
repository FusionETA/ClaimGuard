import "server-only"

import {
  getXeroAccounts,
  getXeroProjects,
  getXeroRuntimeConfigStatus,
  refreshXeroToken,
} from "@/lib/xero"
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
    // Xero rejected the refresh (refresh token already used by a concurrent request).
    // Re-read the token that the winning request stored in DB.
    const fresh = await organizationRepository.getXeroConnectionById(connectionId)
    if (!fresh) return null
    return {
      accessToken: fresh.accessToken,
      tenantId: fresh.tenantId,
    }
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
    const accounts = await getXeroAccounts({
      accessToken: connection.accessToken,
      tenantId: connection.tenantId,
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

  try {
    const projects = await getXeroProjects({
      accessToken: connection.accessToken,
      tenantId: connection.tenantId,
    })

    await organizationRepository.upsertProjectsFromXero({
      xeroConnectionId: connectionId,
      organizationId: connectionRecord.organizationId,
      projects,
    })

    const stored = await organizationRepository.getProjectsForConnection(connectionId)

    return {
      ok: true,
      message: `Imported ${projects.length} Xero projects for this connection.`,
      projects: stored,
    }
  } catch (error) {
    return {
      ok: false,
      message: `Unable to import Xero projects right now: ${trimErrorMessage(error)}`,
    }
  }
}

export async function disconnectXeroConnection(data: {
  connectionId: string
  organizationId: string
}): Promise<{ ok: boolean; message: string }> {
  const connection = await organizationRepository.getXeroConnectionById(data.connectionId)

  if (!connection || connection.organizationId !== data.organizationId) {
    return { ok: false, message: "Xero connection not found." }
  }

  // Best-effort: revoke on Xero's side so the token is invalidated
  try {
    const { deleteXeroConnection: revokeOnXero } = await import("@/lib/xero")
    await revokeOnXero(connection.accessToken, connection.tenantId)
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

export async function syncApprovedClaimToXero(claimId: string): Promise<XeroSyncResult> {
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

  if (claim.xeroBillId) {
    return {
      status: "skipped",
      message: "Xero bill already exists for this claim.",
    }
  }

  return {
    status: "skipped",
    message: "Automatic Xero bill creation is currently disabled while the final sync stage is being defined.",
  }

  // Future re-enable point. When bill creation is turned back on, the
  // shape is roughly:
  //
  //   const connection = await getUsableXeroAccessToken(claim.xeroConnectionId)
  //   if (!connection) { ... }
  //   const bill = await createXeroBill({
  //     accessToken: connection.accessToken,
  //     tenantId: connection.tenantId,
  //     payload: { ... }
  //   })
  //   await claimRepository.markClaimXeroSynced({
  //     claimId: claim.id,
  //     xeroBillId: bill.invoiceId,
  //     xeroBillRef: bill.invoiceNumber,
  //   })
  //
  //   // Bonus: attach the receipt that was uploaded to Xero Files at
  //   // submission time so it appears in the bill's Files panel.
  //   if (claim.xeroFileId) {
  //     try {
  //       await associateFileWithInvoice({
  //         accessToken: connection.accessToken,
  //         tenantId: connection.tenantId,
  //         fileId: claim.xeroFileId,
  //         invoiceId: bill.invoiceId,
  //       })
  //     } catch {
  //       // Non-fatal: bill is still created. Surface as a partial-sync
  //       // warning if you want to track it.
  //     }
  //   }
}
