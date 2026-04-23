import "server-only"

import webpush from "web-push"

import { getPrismaClient } from "@/lib/prisma"

// ---------------------------------------------------------------------------
// VAPID configuration — keys are generated once with:
//   npx web-push generate-vapid-keys
// and stored in .env as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
// ---------------------------------------------------------------------------

webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:admin@claimguard.app",
    process.env.VAPID_PUBLIC_KEY ?? "",
    process.env.VAPID_PRIVATE_KEY ?? ""
)

export function getVapidPublicKey(): string {
    return process.env.VAPID_PUBLIC_KEY ?? ""
}

export type PushPayload = {
    title: string
    body: string
    /** Relative URL to open when the user clicks the notification, e.g. "/employee" */
    url?: string
}

/**
 * Sends a push notification to every registered device for the given user.
 * Stale (HTTP 410) subscriptions are automatically removed from the DB.
 * All errors are swallowed so a push failure never breaks the business flow.
 */
export async function sendPushToUser(
    userId: string,
    payload: PushPayload
): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return

    let subscriptions: { id: string; endpoint: string; p256dh: string; auth: string }[]

    try {
        subscriptions = await prisma.pushSubscription.findMany({
            where: { userId },
            select: { id: true, endpoint: true, p256dh: true, auth: true },
        })
    } catch {
        return
    }

    if (subscriptions.length === 0) return

    const json = JSON.stringify(payload)

    await Promise.allSettled(
        subscriptions.map(async (sub) => {
            try {
                await webpush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                    json
                )
            } catch (err: unknown) {
                // 410 Gone — the browser has revoked this subscription; clean it up.
                const status = (err as { statusCode?: number }).statusCode
                if (status === 410 || status === 404) {
                    try {
                        await prisma.pushSubscription.delete({ where: { id: sub.id } })
                    } catch {
                        /* ignore */
                    }
                }
            }
        })
    )
}
