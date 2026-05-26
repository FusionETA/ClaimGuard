import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import type {
  NotificationType,
  NotificationView,
} from "@/modules/notifications/domain/models"

type NotificationRow = {
  id: string
  type: NotificationType
  title: string
  body: string
  url: string | null
  readAt: Date | null
  createdAt: Date
}

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    url: row.url,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Persistence for in-app notifications. All Prisma access for the
 * `Notification` aggregate lives here. Sending the matching web push is
 * handled separately by the notification service (which calls
 * `sendPushToUser`); this repository only deals with the stored rows.
 */
export const notificationRepository = {
  async create(input: {
    userId: string
    organizationId?: string | null
    type: NotificationType
    title: string
    body: string
    url?: string | null
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return

    await prisma.notification.create({
      data: {
        userId: input.userId,
        organizationId: input.organizationId ?? null,
        type: input.type,
        title: input.title,
        body: input.body,
        url: input.url ?? null,
      },
    })
  },

  /**
   * Most-recent notifications for a user, newest first. `limit` caps the
   * list so the bell dropdown stays light.
   */
  async listForUser(
    userId: string,
    limit = 30,
  ): Promise<NotificationView[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        url: true,
        readAt: true,
        createdAt: true,
      },
    })
    return rows.map((r) => toView(r as NotificationRow))
  },

  async unreadCount(userId: string): Promise<number> {
    const prisma = getPrismaClient()
    if (!prisma) return 0

    return prisma.notification.count({
      where: { userId, readAt: null },
    })
  },

  /**
   * Mark a single notification read, scoped to the owner so a forged id
   * can't acknowledge someone else's notification.
   */
  async markRead(userId: string, id: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return

    await prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    })
  },

  async markAllRead(userId: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return

    await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    })
  },
}
