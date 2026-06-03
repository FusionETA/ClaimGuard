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

  if (error) {
    return finish(`/admin/settings?xero=error&reason=${encodeURIComponent(errorDescription || error)}`)
  }

  if (!code || !state || !cookieState || cookieState !== state) {
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

    let selectableTenants = tenants

    if (isReauth) {
      const existingTenantIds = new Set(
        existingConnections.map((c) => c.tenantId)
      )
      const matched = tenants.find((t) => existingTenantIds.has(t.tenantId))
      if (!matched) {
        const existingNames = existingConnections
          .map((c) => `"${c.tenantName}"`)
          .join(", ")
        return finish(
          `/admin/settings?xero=error&reason=${encodeURIComponent(
            `The Xero account you signed in with doesn't include ${existingNames}. Sign out of Xero in another tab (or use an incognito window), then click "Update permissions" again with the Xero account that owns ${existingNames}.`
          )}`
        )
      }
      selectableTenants = [matched]
    } else if (activeOrgId && tenants.length > 1) {
      const takenTenantIds = new Set(
        await organizationRepository.getInUseTenantIds(
          tenants.map((t) => t.tenantId),
          activeOrgId
        )
      )
      const available = tenants.filter((t) => !takenTenantIds.has(t.tenantId))
      if (available.length === 0) {
        return finish(
          `/admin/settings?xero=error&reason=${encodeURIComponent(
            "Every Xero organisation you authorised is already connected to another company in AltomateHR. Disconnect from the other company first, or sign in with a Xero account that has access to an unconnected organisation."
          )}`
        )
      }
      selectableTenants = available
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
    return finish(`/admin/settings?xero=error&reason=${encodeURIComponent(reason)}`)
  }
}
