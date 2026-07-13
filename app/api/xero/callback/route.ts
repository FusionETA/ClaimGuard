import { revalidatePath } from "next/cache"
import { isAdminRole } from "@/lib/auth/types"
import { NextRequest, NextResponse } from "next/server"

import { getCurrentSession, resolveActiveOrgId, updateCurrentSession } from "@/lib/auth/session"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { getRequestOrigin } from "@/lib/request-origin"
import { exchangeXeroCodeForTokens, getXeroTenants } from "@/lib/xero"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

const XERO_STATE_COOKIE = "claimguard_xero_oauth_state"
export const XERO_PENDING_COOKIE = "claimguard_xero_pending"

export async function GET(request: NextRequest) {
  const origin = getRequestOrigin(request)
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
    return NextResponse.redirect(new URL("/login", origin))
  }

  const { searchParams } = new URL(request.url)
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const error = searchParams.get("error")
  const errorDescription = searchParams.get("error_description")
  const cookieState = request.cookies.get(XERO_STATE_COOKIE)?.value

  const finish = (destination: string) => {
    // Bust the Next.js Router Cache so the settings page re-renders against
    // fresh DB state (new `reauthorizedAt`, cleared `requiresReauth`, etc.).
    // Without this the user lands on a cached snapshot taken BEFORE the
    // OAuth dance — the success banner shows but the connection card still
    // displays the old timestamp and the "Update permissions" badge.
    revalidatePath("/admin/settings")
    revalidatePath("/admin", "layout")
    const response = NextResponse.redirect(new URL(destination, origin))
    response.cookies.set(XERO_STATE_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    })
    return response
  }

  // Does the currently-active company already have a Xero connection?
  // Used to turn "duplicate / replayed callback" outcomes into a benign
  // success redirect instead of a scary error — see the state-cookie check
  // below and the catch block. A replayed callback (browser refresh,
  // Back→Forward, prefetch, or a concurrent duplicate request) re-submits
  // the SAME one-time authorization code; Xero already consumed it on the
  // first, successful exchange, so the connection is genuinely saved even
  // though the second attempt fails.
  const orgAlreadyHasXeroConnection = async (): Promise<boolean> => {
    const activeOrgId = resolveActiveOrgId(session)
    if (!activeOrgId) return false
    try {
      const conns = await organizationRepository.getXeroConnections(activeOrgId)
      return conns.length > 0
    } catch {
      return false
    }
  }

  if (error) {
    return finish(`/admin/settings?xero=error&reason=${encodeURIComponent(errorDescription || error)}`)
  }

  if (!code || !state) {
    return finish("/admin/settings?xero=invalid-state")
  }

  // The OAuth state cookie is httpOnly + single-use: `finish()` clears it on
  // the first callback. So a callback that arrives with a valid-looking
  // code+state but NO state cookie is almost always a REPLAY of the callback
  // URL (browser refresh / Back→Forward) after a connect that already
  // succeeded — not a CSRF attempt. If this company is already connected,
  // treat it as a no-op success rather than scaring the admin with
  // "invalid-state". A cookie that is PRESENT but mismatched is still handled
  // strictly (that's the genuine tamper signature).
  if (!cookieState) {
    if (await orgAlreadyHasXeroConnection()) {
      console.warn(
        "[xero-callback] replayed callback with no state cookie; org already connected — treating as success"
      )
      return finish("/admin/settings?xero=connected")
    }
    return finish("/admin/settings?xero=invalid-state")
  }
  if (cookieState !== state) {
    return finish("/admin/settings?xero=invalid-state")
  }

  try {
    const tokenSet = await exchangeXeroCodeForTokens({
      code,
      requestOrigin: origin,
    })
    const tenants = await getXeroTenants(tokenSet.accessToken)

    if (!tenants.length) {
      return finish("/admin/settings?xero=no-tenant")
    }

    // Decide which tenant(s) the OAuth result is allowed to attach to.
    //
    // RE-AUTH PATH — the active company already has an existing Xero
    // connection. The user clicked "Update permissions" to refresh
    // tokens/scope, NOT to switch tenants. So we look in Xero's
    // response for the existing tenantId and stick with it. If Xero
    // didn't return that tenant (e.g. the user was logged into the
    // wrong Xero account), we refuse to auto-connect a different one
    // and explain what to do.
    //
    // FRESH-CONNECT PATH — no existing connection on the active org
    // (or no active org at all). Drop tenants already taken by sibling
    // AltomateHR companies; whatever's left feeds the picker / auto-
    // connect downstream.
    const activeOrgId = resolveActiveOrgId(session)
    const existingConnections = activeOrgId
      ? await organizationRepository.getXeroConnections(activeOrgId)
      : []
    const isReauth = existingConnections.length > 0

    // Unified selectable-tenants filter for both fresh-connect AND
    // reconnect (a.k.a. reauth). Prior behavior FORCED reconnect to
    // stick with the currently-connected tenant, which meant admins
    // clicking Reconnect to switch to a different Xero tenant would
    // silently get the SAME one re-upserted with a stale tenantName
    // — no way to switch without disconnecting first. Now the filter
    // just drops tenants already taken by OTHER AltomateHR orgs (via
    // getInUseTenantIds, which excludes the current org's own
    // connections), so the current tenant AND any new ones the user
    // just authorised are BOTH selectable. If only one survives →
    // auto-connect. If multiple → show the picker.
    let selectableTenants = tenants
    if (activeOrgId) {
      const takenTenantIds = new Set(
        await organizationRepository.getInUseTenantIds(
          tenants.map((t) => t.tenantId),
          activeOrgId
        )
      )
      selectableTenants = tenants.filter(
        (t) => !takenTenantIds.has(t.tenantId)
      )
      if (selectableTenants.length === 0) {
        return finish(
          `/admin/settings?xero=error&reason=${encodeURIComponent(
            isReauth
              ? "Every Xero organisation you signed in with is currently connected to another company in AltomateHR. Sign in with a Xero account that has access to an unconnected organisation."
              : "Every Xero organisation you authorised is already connected to another company in AltomateHR. Disconnect from the other company first, or sign in with a Xero account that has access to an unconnected organisation."
          )}`
        )
      }
    }

    // More than one connectable org → let the admin pick. Store the token set +
    // the connectable tenants in a short-lived cookie and redirect to the
    // selection screen.
    if (selectableTenants.length > 1) {
      const pendingPayload = JSON.stringify({
        accessToken: tokenSet.accessToken,
        refreshToken: tokenSet.refreshToken,
        scope: tokenSet.scope,
        tokenType: tokenSet.tokenType,
        expiresAt: tokenSet.expiresAt.toISOString(),
        tenants: selectableTenants,
      })

      revalidatePath("/admin/settings")
      revalidatePath("/admin", "layout")
      const response = NextResponse.redirect(
        new URL("/admin/settings?xero=select-tenant", origin)
      )
      response.cookies.set(XERO_STATE_COOKIE, "", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 0,
      })
      response.cookies.set(XERO_PENDING_COOKIE, pendingPayload, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 5,
      })
      return response
    }

    // Exactly one connectable org (only one authorised, or all but one already
    // taken) → connect it directly without showing the picker.
    const tenant = selectableTenants[0]

    // Auto-create org from Xero tenant name if admin hasn't set one yet.
    // Respect activeOrganizationId so the connection attaches to whichever
    // company is currently selected in the org dropdown.
    let organizationId = resolveActiveOrgId(session)
    if (!organizationId) {
      const org = await organizationRepository.upsertAdminOrganization({
        adminUserId: session.userId,
        organizationName: tenant.tenantName,
      })
      organizationId = org.id
      await updateCurrentSession({ organizationId: org.id, organizationName: org.name })
    }

    // Cross-company conflict double-check. The re-auth and fresh-connect
    // branches above already filter most of this, but it's still possible
    // for a fresh connect where Xero returned exactly one tenant (so the
    // multi-tenant filter never ran) and that tenant is owned by a
    // sibling AltomateHR company.
    const inUse = await organizationRepository.getInUseTenantIds(
      [tenant.tenantId],
      organizationId
    )
    if (inUse.length > 0) {
      return finish(
        `/admin/settings?xero=error&reason=${encodeURIComponent(
          `"${tenant.tenantName}" is already connected to a different company in AltomateHR. To move it here, ask the other company's admin to disconnect it first, or sign in with a Xero account that has access to an unconnected organisation.`
        )}`
      )
    }

    const isFirstXeroConnect = !isReauth

    await organizationRepository.upsertXeroConnection({
      organizationId,
      tenantId: tenant.tenantId,
      xeroConnectionId: tenant.connectionId,
      tenantName: tenant.tenantName,
      tenantType: tenant.tenantType,
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken,
      scope: tokenSet.scope,
      tokenType: tokenSet.tokenType,
      accessTokenExpiresAt: tokenSet.expiresAt,
      connectedByAdminId: session.userId,
    })

    void writeAudit({
      organizationId,
      actor: {
        userId: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
      },
      action: "xero.connect",
      status: "SUCCESS",
      summary: `Connected Xero tenant "${tenant.tenantName}"${isFirstXeroConnect ? " (first connect — custom COA + projects disabled)" : ""}`,
      targetType: "xero-tenant",
      targetId: tenant.tenantId,
      metadata: {
        tenantName: tenant.tenantName,
        tenantType: tenant.tenantType,
        firstConnect: isFirstXeroConnect,
      },
    })

    // On first Xero connect, disable any custom COA and projects so Xero takes over
    if (isFirstXeroConnect) {
      await organizationRepository.disableCustomRecordsOnXeroConnect(organizationId)
    }

    await bustOrgConfigCaches({ organizationId })

    return finish("/admin/settings?xero=connected")
  } catch (callbackError) {
    const reason =
      callbackError instanceof Error ? callbackError.message : "Unable to connect to Xero."

    // Xero returns `invalid_grant` / "Authorization code not found" when the
    // one-time authorization code has already been consumed — a duplicate or
    // concurrent callback hit (browser prefetch, double-click, refresh) — or
    // when the code expired. In the duplicate case the FIRST exchange already
    // saved the connection, so surfacing the raw error is misleading: the
    // admin DID connect. If the active company already has a Xero connection,
    // show the success state instead of the error.
    const isConsumedOrExpiredCode =
      /invalid_grant|Authorization code not found/i.test(reason)
    if (isConsumedOrExpiredCode && (await orgAlreadyHasXeroConnection())) {
      console.warn(
        `[xero-callback] token exchange failed on a duplicate/replayed code but org is already connected — treating as success: ${reason}`
      )
      return finish("/admin/settings?xero=connected")
    }

    console.error(`[xero-callback] connect failed: ${reason}`)
    return finish(`/admin/settings?xero=error&reason=${encodeURIComponent(reason)}`)
  }
}
