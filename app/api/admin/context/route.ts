import { NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

export async function GET() {
  const session = await getCurrentSession()

  if (!session || session.role !== "ADMIN") {
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
      activeOrganizationId: session.activeOrganizationId ?? session.organizationId ?? null,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  )
}
