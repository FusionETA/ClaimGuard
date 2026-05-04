import { type NextRequest, NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { pushSubscriptionRepository } from "@/modules/notifications/infrastructure/push-subscription.repository"

/** POST /api/push/unsubscribe — removes a push subscription by endpoint */
export async function POST(req: NextRequest) {
  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { endpoint?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  if (!body.endpoint) {
    return NextResponse.json({ error: "Missing endpoint" }, { status: 400 })
  }

  await pushSubscriptionRepository.deleteForUserEmail({
    email: session.email,
    endpoint: body.endpoint,
  })

  return NextResponse.json({ ok: true })
}
