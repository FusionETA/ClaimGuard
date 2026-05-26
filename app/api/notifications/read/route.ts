import { NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/modules/notifications/application/services/notification.service"

/**
 * POST /api/notifications/read
 *
 * Marks notifications read for the current user. Body:
 *   { id: "<notificationId>" } → mark that one read
 *   { all: true }             → mark every unread one read
 * The mark is scoped to the session user, so a forged id can't
 * acknowledge another user's notification.
 */
export async function POST(request: Request) {
  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.json(
      { message: "Unauthorized." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    )
  }

  let body: { id?: unknown; all?: unknown }
  try {
    body = (await request.json()) as { id?: unknown; all?: unknown }
  } catch {
    return NextResponse.json(
      { message: "Invalid JSON body." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    )
  }

  if (body.all === true) {
    await markAllNotificationsRead(session.userId)
  } else if (typeof body.id === "string" && body.id.trim() !== "") {
    await markNotificationRead(session.userId, body.id)
  } else {
    return NextResponse.json(
      { message: "Provide either { id } or { all: true }." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    )
  }

  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  )
}
