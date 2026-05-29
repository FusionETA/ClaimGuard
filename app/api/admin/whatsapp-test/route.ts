import { NextRequest, NextResponse } from "next/server"

import { getCurrentSession } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import {
  normalisePhone,
  sendWhatsApp,
  verifyWhatsAppConnection,
} from "@/lib/whatsapp"

/**
 * GET  /api/admin/whatsapp-test
 *   → Reads the resolved WAZZUP_* env vars (NEVER returns the key)
 *     and calls Wazzup's GET /channels endpoint to verify auth and
 *     that WAZZUP_CHANNEL_ID is a real channel on the account. No
 *     message is sent.
 *
 * GET  /api/admin/whatsapp-test?to=60123456789
 *   → Same as above, plus attempts an actual WhatsApp send to the
 *     supplied phone if verify() passed. Confirms end-to-end
 *     delivery.
 *
 * Auth: must be signed in as ADMIN or OWNER.
 *
 * Response always 200; the verify/send blocks carry the result so
 * the JSON shape can be copy-pasted back for debugging:
 *
 *   {
 *     "verify": { "ok": true|false, "config": {...}, "error"?: "..." },
 *     "send"?:  { "ok": true|false, "to": "...", "messageId"?: "...", "error"?: "..." }
 *   }
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized — admin / owner session required." },
      { status: 401 },
    )
  }

  const verify = await verifyWhatsAppConnection()

  // Optional end-to-end send. Only fires when `?to=` is provided AND
  // the verify step succeeded.
  const toRaw = request.nextUrl.searchParams.get("to")?.trim() ?? null
  const to = normalisePhone(toRaw)
  let send:
    | {
        ok: boolean
        to?: string
        messageId?: string
        error?: string
      }
    | undefined

  if (toRaw && verify.ok) {
    if (!to) {
      send = {
        ok: false,
        error: `Could not normalise phone "${toRaw}" — needs at least one digit.`,
      }
    } else {
      const result = await sendWhatsApp({
        to,
        text:
          `AltomateHR WhatsApp diagnostic — sent by ${session.email} at ${new Date().toISOString()}. ` +
          `If you can read this, the password-reset flow will reach this number.`,
      })
      send = result.delivered
        ? { ok: true, to, messageId: result.messageId }
        : { ok: false, to, error: result.reason ?? "send-failed" }
    }
  }

  return NextResponse.json({ verify, ...(send ? { send } : {}) })
}
