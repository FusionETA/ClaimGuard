"use client"

import { useActionState } from "react"

import {
  lockAction,
  updateTokenScopesAction,
} from "@/app/internal/api-scopes/actions"
import { initialScopeUpdateState } from "@/app/internal/api-scopes/form-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useToastOnAction } from "@/components/ui/toaster"
import { API_SCOPE_CATALOG, type ApiScope } from "@/lib/api-scopes"

/**
 * One row per token. Each row is its own form so checkbox state +
 * pending state are independent — saving token A doesn't touch
 * token B's checkboxes.
 */
type TokenItem = {
  id: string
  name: string
  tokenPrefix: string
  scopes: string[]
  active: boolean
  createdAt: string
  lastUsedAt: string | null
  organizationId: string
  organizationName: string
}

export function ScopeEditor({ tokens }: { tokens: TokenItem[] }) {
  // Group by organisation so the page renders as a flat list of cards
  // grouped by org header. Keeps the visual hierarchy clear when an org
  // has multiple tokens.
  const byOrg = new Map<string, { orgName: string; rows: TokenItem[] }>()
  for (const t of tokens) {
    const existing = byOrg.get(t.organizationId)
    if (existing) existing.rows.push(t)
    else byOrg.set(t.organizationId, { orgName: t.organizationName, rows: [t] })
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <form action={lockAction}>
          <Button type="submit" variant="outline" size="sm">
            Lock
          </Button>
        </form>
      </div>

      {byOrg.size === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No API tokens exist on any organisation yet.
          </CardContent>
        </Card>
      ) : (
        Array.from(byOrg.entries()).map(([orgId, group]) => (
          <section key={orgId} className="space-y-3">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-bold uppercase tracking-wide">
                {group.orgName}
              </h2>
              <span className="text-xs text-muted-foreground">
                org {orgId}
              </span>
            </div>
            <div className="space-y-3">
              {group.rows.map((token) => (
                <TokenRow key={token.id} token={token} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

function TokenRow({ token }: { token: TokenItem }) {
  const [state, formAction, pending] = useActionState(
    updateTokenScopesAction,
    initialScopeUpdateState,
  )
  useToastOnAction(state)

  // Show success / error inline on the row that was actually saved.
  // The action returns tokenId so we can match without prop drilling.
  const inlineFeedback =
    state.tokenId === token.id && state.status !== "idle"
      ? state
      : null

  const lastUsedLabel = token.lastUsedAt
    ? new Date(token.lastUsedAt).toLocaleString()
    : "never"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{token.name}</CardTitle>
            <CardDescription className="font-mono text-xs">
              {token.tokenPrefix}…
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {token.active ? (
              <Badge variant="success" className="text-[10px]">
                Active
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">
                Inactive
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground">
              last used: {lastUsedLabel}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="tokenId" value={token.id} />
          <div className="grid gap-1.5 sm:grid-cols-2">
            {API_SCOPE_CATALOG.map((scope) => (
              <ScopeCheckbox
                key={scope}
                scope={scope}
                defaultChecked={token.scopes.includes(scope)}
                disabled={pending}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-3">
            {inlineFeedback ? (
              <p
                className={
                  inlineFeedback.status === "error"
                    ? "text-xs font-medium text-destructive"
                    : "text-xs font-medium text-emerald-600"
                }
              >
                {inlineFeedback.message}
              </p>
            ) : (
              <span />
            )}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save scopes"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ScopeCheckbox({
  scope,
  defaultChecked,
  disabled,
}: {
  scope: ApiScope
  defaultChecked: boolean
  disabled: boolean
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5 text-xs hover:bg-muted/40 cursor-pointer">
      <input
        type="checkbox"
        name="scopes"
        value={scope}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="h-3.5 w-3.5"
      />
      <span className="font-mono">{scope}</span>
    </label>
  )
}
