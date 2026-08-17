import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import { API_FEATURE_CATALOG } from "@/lib/api-features"

/**
 * GET /api/v1/whoami
 *
 * Token introspection. Returns the organization this token belongs to and
 * its granted scopes. Companion apps (e.g. ABPay) call this with a freshly
 * pasted `wp_live_*` token to confirm it's valid AND belongs to the
 * expected company before storing it — pasting company A's token onto
 * company B is caught by comparing `organizationId`.
 *
 * Also returns `features` — the optional request blocks this deployment
 * understands (see `lib/api-features.ts`). Our PATCH schemas are
 * `.strict()`, so a partner can't probe by just sending a new key: one
 * unknown field 400s the whole call. Gating each optional block on its
 * flag lets both sides ship independently instead of coordinating
 * deploys. `scopes` says what this token may do; `features` says what
 * this deployment can be asked for.
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
      features: [...API_FEATURE_CATALOG],
    },
  })
})
