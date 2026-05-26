import "server-only"

import { publishUserEvent } from "@/lib/realtime"
import { sendPushToUser } from "@/lib/web-push"
import type { NotificationType, NotificationView } from "@/modules/notifications/domain/models"
import { notificationRepository } from "@/modules/notifications/infrastructure/notification.repository"

/**
 * Single funnel for delivering a notification to a user: persist it to the
 * `Notification` table (so it shows up in the in-app bell/list) AND send
 * the matching web push. Both steps are best-effort — a failure in either
 * must never break the business flow that triggered the notification, so
 * everything is wrapped in catch and swallowed (push already swallows
 * internally; we guard the DB write too).
 */
export async function notify(input: {
  userId: string
  organizationId?: string | null
  type: NotificationType
  title: string
  body: string
  url?: string | null
}): Promise<void> {
  try {
    await notificationRepository.create({
      userId: input.userId,
      organizationId: input.organizationId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      url: input.url ?? null,
    })
  } catch {
    // Persisting the in-app notification is best-effort.
  }

  try {
    await sendPushToUser(input.userId, {
      title: input.title,
      body: input.body,
      url: input.url ?? undefined,
    })
  } catch {
    // sendPushToUser swallows internally; belt + suspenders.
  }

  // Live in-app update (SSE): nudge any open tab for this user to refresh
  // the page (supervisor queue) + the notification bell. Best-effort and
  // a no-op when Redis isn't configured.
  await publishUserEvent(input.userId, { type: "notification" })
}

export async function getNotificationsForUser(
  userId: string,
): Promise<{ notifications: NotificationView[]; unreadCount: number }> {
  const [notifications, unreadCount] = await Promise.all([
    notificationRepository.listForUser(userId),
    notificationRepository.unreadCount(userId),
  ])
  return { notifications, unreadCount }
}

export async function markNotificationRead(
  userId: string,
  id: string,
): Promise<void> {
  await notificationRepository.markRead(userId, id)
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await notificationRepository.markAllRead(userId)
}
