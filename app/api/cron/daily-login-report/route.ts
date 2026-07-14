import { NextRequest, NextResponse } from "next/server"

import { buildDailyLoginReport } from "@/modules/audit/application/services/audit-log.service"

/**
 * POST /api/cron/daily-login-report
 *
 * Sends a WhatsApp summary of every EMPLOYEE / SUPERVISOR sign-in over
 * the past 24 hours to the phone(s) listed in `WAZZUP_ERROR_NOTIFY_PHONES`.
 * Cross-org — the endpoint iterates every organization's audit log.
 *
 * Auth: bearer $CRON_SECRET (same pattern as the other /api/cron/* routes).
 *
 * Env required on the server:
 *   CRON_SECRET
 *   WAZZUP_API_KEY
 *   WAZZUP_CHANNEL_ID
 *   WAZZUP_ERROR_NOTIFY_PHONES   comma-separated E.164 (no leading `+`)
 *
 * Recommended cron: daily at 19:00 MYT via the local scheduled task
 * `daily-login-report`. That task just curls this endpoint.
 *
 *   curl -X POST https://<host>/api/cron/daily-login-report \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Returns `{ ok, uniqueUsers, totalSessions, sent, failed }` on success.
 * `sent` = how many WhatsApp POSTs Wazzup accepted (2xx). Even zero
 * sign-ins triggers a "no sign-ins" message so silent days don't look
 * like a broken pipeline.
 */
export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured on server" },
      { status: 500 },
    )
  }
  const auth = request.headers.get("authorization") ?? ""
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match || match[1].trim() !== expected) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    )
  }

  const apiKey = process.env.WAZZUP_API_KEY?.trim()
  const channelId = process.env.WAZZUP_CHANNEL_ID?.trim()
  const phonesEnv = process.env.WAZZUP_ERROR_NOTIFY_PHONES?.trim()
  if (!apiKey || !channelId || !phonesEnv) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Wazzup env missing (need WAZZUP_API_KEY / WAZZUP_CHANNEL_ID / WAZZUP_ERROR_NOTIFY_PHONES)",
      },
      { status: 500 },
    )
  }
  const phones = phonesEnv
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  if (phones.length === 0) {
    return NextResponse.json(
      { ok: false, error: "WAZZUP_ERROR_NOTIFY_PHONES has no recipients" },
      { status: 500 },
    )
  }

  try {
    const report = await buildDailyLoginReport({ lookbackHours: 24 })

    // Send to every phone in the recipient list. Wazzup24 doesn't
    // support broadcast in a single call; sequential is fine at
    // <10 recipients. Independent failure per phone so one bad
    // number doesn't kill the rest.
    let sent = 0
    let failed = 0
    const failures: Array<{ phone: string; status: number; body: string }> = []
    for (const phone of phones) {
      const res = await fetch("https://api.wazzup24.com/v3/message", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channelId,
          chatType: "whatsapp",
          chatId: phone,
          text: report.message,
        }),
      })
      if (res.ok) {
        sent += 1
      } else {
        failed += 1
        failures.push({
          phone,
          status: res.status,
          body: (await res.text()).slice(0, 200),
        })
      }
    }

    return NextResponse.json({
      ok: true,
      uniqueUsers: report.uniqueUsers,
      totalSessions: report.totalSessions,
      sent,
      failed,
      ...(failures.length > 0 ? { failures } : {}),
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "report build/send failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
