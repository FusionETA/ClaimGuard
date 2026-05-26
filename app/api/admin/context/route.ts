import { NextResponse } from "next/server"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

export async function GET() {
  const session = await getCurrentSession()

  if (!session || !isAdminRole(session.role)) {
    return NextResponse.json(
      { message: "Unauthorized." },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    )
  }

  const adminOrganizations = session.userId
    ? await organizationRepository.getAdminOrganizations(session.userId)
    : []

  return NextResponse.json(
    {
      adminOrganizations,
      activeOrganizationId: resolveActiveOrgId(session) ?? null,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  )
}
