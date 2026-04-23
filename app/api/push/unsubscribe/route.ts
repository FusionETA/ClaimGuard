import { type NextRequest, NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"

/** POST /api/push/unsubscribe — removes a push subscription by endpoint */
export async function POST(req: NextRequest) {
    const session = await getCurrentSession()
    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const prisma = getPrismaClient()
    if (!prisma) {
        return NextResponse.json({ error: "DB unavailable" }, { status: 503 })
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

    // Only delete if it belongs to the current user (security guard).
    await prisma.pushSubscription
        .deleteMany({
            where: {
                endpoint: body.endpoint,
                user: { email: session.email },
            },
        })
        .catch(() => {
            /* ignore — subscription may already be gone */
        })

    return NextResponse.json({ ok: true })
}
