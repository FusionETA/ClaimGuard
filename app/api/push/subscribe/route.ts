import { type NextRequest, NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import { getVapidPublicKey } from "@/lib/web-push"

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

    const prisma = getPrismaClient()
    if (!prisma) {
        return NextResponse.json({ error: "DB unavailable" }, { status: 503 })
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

    // Find the user's DB id from the session email.
    const user = await prisma.user.findUnique({
        where: { email: session.email },
        select: { id: true },
    })

    if (!user) {
        return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    // Upsert so re-subscribing on the same device doesn't create duplicates.
    await prisma.pushSubscription.upsert({
        where: { endpoint },
        update: { p256dh: keys.p256dh, auth: keys.auth, userId: user.id },
        create: { userId: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
    })

    return NextResponse.json({ ok: true })
}
