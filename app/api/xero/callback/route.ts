import { NextRequest, NextResponse } from "next/server"

import { getCurrentSession, updateCurrentSession } from "@/lib/auth/session"
import { exchangeXeroCodeForTokens, getXeroTenants } from "@/lib/xero"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

const XERO_STATE_COOKIE = "claimguard_xero_oauth_state"
export const XERO_PENDING_COOKIE = "claimguard_xero_pending"

export async function GET(request: NextRequest) {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return NextResponse.redirect(new URL("/login", request.url))
  }

  const { searchParams } = new URL(request.url)
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const error = searchParams.get("error")
  const errorDescription = searchParams.get("error_description")
  const cookieState = request.cookies.get(XERO_STATE_COOKIE)?.value

  const finish = (destination: string) => {
    const response = NextResponse.redirect(new URL(destination, request.url))
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
    const tokenSet = await exchangeXeroCodeForTokens(code)
    const tenants = await getXeroTenants(tokenSet.accessToken)

    if (!tenants.length) {
      return finish("/admin/settings?xero=no-tenant")
    }

    // If the user authorised more than one Xero organisation, let them pick which
    // one to connect. Store the token set in a short-lived pending cookie and
    // redirect to the selection screen. The selected tenant will be saved there;
    // the rest are simply not stored (effectively disconnected).
    if (tenants.length > 1) {
      const pendingPayload = JSON.stringify({
        accessToken: tokenSet.accessToken,
        refreshToken: tokenSet.refreshToken,
        scope: tokenSet.scope,
        tokenType: tokenSet.tokenType,
        expiresAt: tokenSet.expiresAt.toISOString(),
        tenants,
      })

      const response = NextResponse.redirect(
        new URL("/admin/settings?xero=select-tenant", request.url)
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

    const tenant = tenants[0]

    // Auto-create org from Xero tenant name if admin hasn't set one yet.
    // Respect activeOrganizationId so the connection attaches to whichever
    // company is currently selected in the org dropdown.
    let organizationId = session.activeOrganizationId ?? session.organizationId
    if (!organizationId) {
      const org = await organizationRepository.upsertAdminOrganization({
        adminUserId: session.userId,
        organizationName: tenant.tenantName,
      })
      organizationId = org.id
      await updateCurrentSession({ organizationId: org.id, organizationName: org.name })
    }

    const inUse = await organizationRepository.getInUseTenantIds(
      [tenant.tenantId],
      organizationId
    )
    if (inUse.length > 0) {
      return finish(
        `/admin/settings?xero=error&reason=${encodeURIComponent(
          `"${tenant.tenantName}" is already connected to another organisation. Please contact your administrator.`
        )}`
      )
    }

    // Check if this org had no Xero connections before (first connect)
    const existingConnections = await organizationRepository.getXeroConnections(organizationId)
    const hasDifferentExistingConnection = existingConnections.some(
      (connection) => connection.tenantId !== tenant.tenantId
    )

    if (hasDifferentExistingConnection) {
      return finish(
        `/admin/settings?xero=error&reason=${encodeURIComponent(
          "This company is already connected to a different Xero organization. Disconnect the current one before connecting a new one."
        )}`
      )
    }

    const isFirstXeroConnect = existingConnections.length === 0

    await organizationRepository.upsertXeroConnection({
      organizationId,
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      tenantType: tenant.tenantType,
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken,
      scope: tokenSet.scope,
      tokenType: tokenSet.tokenType,
      accessTokenExpiresAt: tokenSet.expiresAt,
      connectedByAdminId: session.userId,
    })

    // On first Xero connect, disable any custom COA and projects so Xero takes over
    if (isFirstXeroConnect) {
      await organizationRepository.disableCustomRecordsOnXeroConnect(organizationId)
    }

    return finish("/admin/settings?xero=connected")
  } catch (callbackError) {
    const reason =
      callbackError instanceof Error ? callbackError.message : "Unable to connect to Xero."
    return finish(`/admin/settings?xero=error&reason=${encodeURIComponent(reason)}`)
  }
}
