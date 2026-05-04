import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { verifyPassword } from "@/lib/auth/password"
import type {
  SessionUser,
} from "@/lib/auth/types"
import { buildInitials } from "@/lib/utils"

function buildSubtitle(
  role: "ADMIN" | "EMPLOYEE" | "SUPERVISOR",
  profile: { jobTitle: string } | null
) {
  if (role === "ADMIN") {
    return "Administrator"
  }

  if (role === "SUPERVISOR") {
    return profile?.jobTitle ?? "Supervisor"
  }

  return profile?.jobTitle ?? "Employee"
}

export async function authenticateUser({
  email,
  password,
}: {
  email: string
  password: string
}) {
  const normalizedEmail = email.trim().toLowerCase()
  const prisma = getPrismaClient()

  if (!prisma) {
    return {
      success: false as const,
      message: "Database is not configured. Contact your administrator.",
    }
  }

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: { employeeProfile: true, organization: true },
  })

  if (!user) {
    return {
      success: false as const,
      message: "Invalid email or password.",
    }
  }

  if (!verifyPassword(password, user.passwordHash)) {
    return {
      success: false as const,
      message: "Invalid email or password.",
    }
  }

  // Pre-populate the active Xero connection so every downstream query that
  // reads session.activeXeroConnectionId can trust it without re-resolving.
  // Picks the first connection on the user's organization at login time.
  let activeXeroConnectionId: string | undefined
  if (user.organizationId) {
    const firstConnection = await prisma.xeroConnection.findFirst({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    })
    activeXeroConnectionId = firstConnection?.id ?? undefined
  }

  return {
    success: true as const,
    user: {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      initials: buildInitials(user.name),
      subtitle: buildSubtitle(user.role, user.employeeProfile),
      organizationId: user.organizationId ?? undefined,
      organizationName: user.organization?.name ?? undefined,
      activeOrganizationId: user.organizationId ?? undefined,
      activeXeroConnectionId,
    } satisfies SessionUser,
  }
}
