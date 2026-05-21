import { type NextRequest, NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { rateLimit } from "@/lib/rate-limit"
import { getVapidPublicKey } from "@/lib/web-push"
import { pushSubscriptionRepository } from "@/modules/notifications/infrastructure/push-subscription.repository"

/** GET /api/push/subscribe — returns the VAPID public key for the client to use */
export async function GET() {
  return NextResponse.json({ publicKey: getVapidPublicKey() })
}

/** POST /api/push/subscribe — saves a push subscription for the current user */
export async function POST(req: NextRequest) {
  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const rl = await rateLimit({
    scope: "push:subscribe",
    id: session.userId,
    max: 30,
    windowSec: 60,
  })
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    )
  }

  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const { endpoint, keys } = body
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json({ error: "Missing subscription fields" }, { status: 400 })
  }

  const result = await pushSubscriptionRepository.upsertForUserEmail({
    email: session.email,
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
  })

  if (!result.ok) {
    if (result.reason === "no-db") {
      return NextResponse.json({ error: "DB unavailable" }, { status: 503 })
    }
    if (result.reason === "user-not-found") {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }
  }

  return NextResponse.json({ ok: true })
}
