import { isInternalUnlocked } from "@/app/internal/api-scopes/internal-auth"
import { UnlockForm } from "@/app/internal/api-scopes/unlock-form"
import { ScopeEditor } from "@/app/internal/api-scopes/scope-editor"
import { apiIntegrationRepository } from "@/modules/organization/infrastructure/api-integration.repository"

/**
 * /internal/api-scopes
 *
 * Internal admin page for FusionETA (not for org admins). Lets us:
 *   - See every API token across every organisation
 *   - Tick / untick scopes per token
 *
 * Gated by a password (env `INTERNAL_ADMIN_KEY`, fallback `12345qwerty`)
 * stored in a 1-hour cookie. When locked, the page renders only the
 * unlock form — no leak of token info or even confirmation that the
 * page does anything useful.
 *
 * NOT in `(admin)` route group — bypasses the org-admin session check.
 * The internal-auth module is the only gate.
 */
export const dynamic = "force-dynamic"

export default async function InternalApiScopesPage() {
  const unlocked = await isInternalUnlocked()

  if (!unlocked) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-sm space-y-6 rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="space-y-1">
            <h1 className="text-xl font-bold">Internal · API Scopes</h1>
            <p className="text-xs text-muted-foreground">
              FusionETA admin tool. Enter the internal password to continue.
            </p>
          </div>
          <UnlockForm />
        </div>
      </main>
    )
  }

  const tokens = await apiIntegrationRepository.listAllTokensWithOrg()

  return (
    <main className="min-h-screen bg-muted/30 p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">Internal · API Scopes</h1>
            <p className="text-xs text-muted-foreground">
              {tokens.length} token{tokens.length === 1 ? "" : "s"} across all
              organisations. Tick scopes to grant, untick to revoke.
            </p>
          </div>
        </header>
        <ScopeEditor tokens={tokens} />
      </div>
    </main>
  )
}
