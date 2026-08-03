import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"

/**
 * GET /api/v1/whoami
 *
 * Token introspection. Returns the organization this token belongs to and
 * its granted scopes. Companion apps (e.g. ABPay) call this with a freshly
 * pasted `wp_live_*` token to confirm it's valid AND belongs to the
 * expected company before storing it — pasting company A's token onto
 * company B is caught by comparing `organizationId`.
 *
 * Requires only a valid token (no scope) — same gate as the SSO-ticket and
 * auth-verify routes.
 */
export const GET = handleApiRequest([], async (_request, { integration }) => {
  return NextResponse.json({
    data: {
      organizationId: integration.organizationId,
      tokenName: integration.name,
      scopes: integration.scopes,
    },
  })
})
