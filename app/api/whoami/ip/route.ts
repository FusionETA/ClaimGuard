import { headers } from "next/headers"
import { NextResponse } from "next/server"

import { requireSessionForRole } from "@/lib/auth/session"
import { extractClientIp } from "@/lib/ip-whitelist"

/**
 * GET /api/whoami/ip
 *
 * Returns the caller's public IP as seen by the Next.js server.
 * Used by the admin project-settings form to fill the "Allowed IPs"
 * field with the admin's current office IP in one click, so they don't
 * have to copy-paste it from an external whatismyip service.
 *
 * ADMIN-only — this leaks the caller's public IP to itself, which is
 * fine, but the endpoint should still not be exposed as a general
 * "look up any user's IP" tool. Employees would never call it (no UI
 * hook).
 *
 * Returns `{ ip: null }` when neither `x-forwarded-for` nor `x-real-ip`
 * is present (bare localhost dev with no proxy).
 */
export const dynamic = "force-dynamic"

export async function GET() {
  const session = await requireSessionForRole("ADMIN")
  if (!session.ok) {
    return NextResponse.json({ ip: null }, { status: 401 })
  }
  const ip = extractClientIp(await headers())
  return NextResponse.json({ ip })
}
