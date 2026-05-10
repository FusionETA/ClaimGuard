import { NextRequest, NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { disconnectXeroConnection } from "@/modules/organization/application/services/xero-connection.service"

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!session.organizationId) {
    return NextResponse.json({ error: "No organization found." }, { status: 400 })
  }

  const { connectionId } = await params
  const result = await disconnectXeroConnection({
    connectionId,
    organizationId: session.organizationId,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: 400 })
  }

  // Disconnecting Xero changes the org's Xero connection state, which
  // affects chart accounts, projects, and the admin settings page-data
  // cache. Sweep org config keys so the next read reflects the change.
  await bustOrgConfigCaches({ organizationId: session.organizationId })

  return NextResponse.json({ message: result.message })
}
