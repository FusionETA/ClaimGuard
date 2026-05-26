import { NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { getNotificationsForUser } from "@/modules/notifications/application/services/notification.service"

/**
 * GET /api/notifications
 *
 * Returns the current user's most-recent notifications plus their unread
 * count, for the header bell + dropdown. Any authenticated user (admin,
 * owner, supervisor, or employee) can read their own notifications.
 */
export async function GET() {
  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.json(
      { message: "Unauthorized." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    )
  }

  const { notifications, unreadCount } = await getNotificationsForUser(
    session.userId,
  )

  return NextResponse.json(
    { notifications, unreadCount },
    { headers: { "Cache-Control": "no-store" } },
  )
}
