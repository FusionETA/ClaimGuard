"use client"

import { useState, useTransition } from "react"
import { Copy, KeyRound, Loader2, Plus, ShieldX, Trash2 } from "lucide-react"

import {
  createApiTokenAction,
  deleteApiTokenAction,
  setApiTokenActiveAction,
} from "@/app/(admin)/admin/settings/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toaster"
import { API_SCOPE_CATALOG, type ApiScope } from "@/lib/api-scopes"

type Integration = {
  id: string
  name: string
  tokenPrefix: string
  scopes: string[]
  active: boolean
  createdAt: string
  lastUsedAt: string | null
}

const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "employees:read": "List & view employees",
  "employees:write": "Create, edit, delete employees",
  "teams:read": "List & view teams + chains",
  "teams:write": "Create, edit, delete teams + chains",
  "projects:read": "List & view projects",
  "projects:write": "Create, edit, delete projects",
  "chart-of-accounts:read": "List & view chart of accounts",
  "chart-of-accounts:write": "Create, edit, delete custom accounts",
  "claims:read": "List & view claims",
  "claims:write": "Create / edit claims on behalf of employees",
  "attendance:read": "List & view attendance + rollcall",
  "attendance:write": "Create, edit attendance records",
  "leave:read": "List & view leave requests",
  "leave:write": "Create / edit leave requests",
  "settings:read": "View org settings (cutoff, currencies, OT rates, etc)",
  "settings:write": "Update org settings",
  "approvals:write": "Approve / reject claims & attendance approvals",
}

/**
 * Settings → API tab. Shows existing integration tokens, lets the admin
 * create new ones (raw token shown once on creation), revoke / re-enable
 * existing ones, and delete dead ones permanently.
 *
 * No useActionState here because we need access to the action's return
 * value (the secret token) immediately on success — and useActionState
 * doesn't give us a clean way to read non-state shaped responses. Plain
 * useTransition + manual state is simpler.
 */
export function ApiIntegrationsTab({
  integrations,
}: {
  integrations: Integration[]
}) {
  const { toast } = useToast()
  const [createOpen, setCreateOpen] = useState(false)
  const [revealedToken, setRevealedToken] = useState<{
    name: string
    token: string
    prefix: string
  } | null>(null)
  const [pending, startTransition] = useTransition()

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              API tokens
            </CardTitle>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Bearer tokens for external systems calling{" "}
              <code className="rounded bg-surface-low px-1 py-0.5 text-xs">
                /api/v1
              </code>
              . Each token is permanently scoped to this organisation and the
              scopes you select below. The raw secret is shown once on
              creation — copy it then. We only store its hash.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-xl"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New token
          </Button>
        </CardHeader>
        <CardContent>
          {integrations.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border/60 bg-surface-low px-4 py-6 text-center text-sm text-muted-foreground">
              No API tokens yet. Create one to let an external system push
              data into this organisation.
            </p>
          ) : (
            <ul className="space-y-2">
              {integrations.map((it) => (
                <IntegrationRow
                  key={it.id}
                  integration={it}
                  pending={pending}
                  onSetActive={(active) => {
                    startTransition(async () => {
                      const result = await setApiTokenActiveAction({
                        integrationId: it.id,
                        active,
                      })
                      toast({
                        title: result.message,
                        variant: result.ok ? "success" : "error",
                      })
                    })
                  }}
                  onDelete={() => {
                    if (
                      !window.confirm(
                        `Delete token "${it.name}" permanently? Any system using it will start getting 401 immediately.`,
                      )
                    ) {
                      return
                    }
                    startTransition(async () => {
                      const result = await deleteApiTokenAction({
                        integrationId: it.id,
                      })
                      toast({
                        title: result.message,
                        variant: result.ok ? "success" : "error",
                      })
                    })
                  }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateTokenDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSuccess={(name, token, prefix) => {
          setCreateOpen(false)
          setRevealedToken({ name, token, prefix })
        }}
      />

      <RevealedTokenDialog
        revealed={revealedToken}
        onClose={() => setRevealedToken(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Integration row
// ---------------------------------------------------------------------------

function IntegrationRow({
  integration,
  pending,
  onSetActive,
  onDelete,
}: {
  integration: Integration
  pending: boolean
  onSetActive: (active: boolean) => void
  onDelete: () => void
}) {
  return (
    <li className="flex items-start gap-3 rounded-2xl border border-border/60 bg-surface-low px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-semibold text-foreground">
            {integration.name}
          </p>
          {!integration.active ? (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-900">
              Revoked
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          <code>{integration.tokenPrefix}…</code> · created{" "}
          {new Date(integration.createdAt).toLocaleDateString()}{" "}
          {integration.lastUsedAt
            ? `· last used ${new Date(integration.lastUsedAt).toLocaleString()}`
            : "· never used"}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {integration.scopes.map((scope) => (
            <span
              key={scope}
              className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"
            >
              {scope}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => onSetActive(!integration.active)}
          className="text-xs"
        >
          <ShieldX className="mr-1 h-3.5 w-3.5" />
          {integration.active ? "Revoke" : "Re-enable"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={onDelete}
          className="text-xs text-destructive hover:text-destructive"
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

function CreateTokenDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean
  onClose: () => void
  onSuccess: (name: string, token: string, prefix: string) => void
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<Set<string>>(new Set())

  function reset() {
    setName("")
    setScopes(new Set())
  }

  function toggleScope(scope: string) {
    setScopes((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) {
        next.delete(scope)
      } else {
        next.add(scope)
      }
      return next
    })
  }

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await createApiTokenAction(formData)
      if (result.ok && result.secretToken && result.prefix) {
        toast({ title: result.message, variant: "success" })
        onSuccess(name.trim(), result.secretToken, result.prefix)
        reset()
      } else {
        toast({ title: result.message, variant: "error" })
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset()
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create API token</DialogTitle>
          <DialogDescription>
            Pick scopes carefully — a token gets exactly what you tick here,
            nothing more. You can revoke it later but you can&rsquo;t edit
            scopes after creation.
          </DialogDescription>
        </DialogHeader>

        <form action={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <label
              htmlFor="apiTokenName"
              className="text-sm font-semibold text-muted-foreground"
            >
              Label
            </label>
            <Input
              id="apiTokenName"
              name="name"
              type="text"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme HR Portal"
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              Internal label so you can tell tokens apart in the list.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold text-muted-foreground">
              Scopes ({scopes.size} selected)
            </p>
            <div className="grid gap-1 sm:grid-cols-2">
              {API_SCOPE_CATALOG.map((scope) => {
                const checked = scopes.has(scope)
                return (
                  <label
                    key={scope}
                    className="flex cursor-pointer items-start gap-2 rounded-xl border border-border/60 bg-surface-low px-3 py-2 hover:bg-card"
                  >
                    <input
                      type="checkbox"
                      name="scopes"
                      value={scope}
                      checked={checked}
                      onChange={() => toggleScope(scope)}
                      disabled={pending}
                      className="mt-0.5 h-4 w-4 accent-primary"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs font-semibold">
                        {scope}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {SCOPE_DESCRIPTIONS[scope]}
                      </p>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset()
                onClose()
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || !name.trim() || scopes.size === 0}
              className="rounded-xl"
            >
              {pending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create token"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// "Show secret once" dialog
// ---------------------------------------------------------------------------

function RevealedTokenDialog({
  revealed,
  onClose,
}: {
  revealed: { name: string; token: string; prefix: string } | null
  onClose: () => void
}) {
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)

  async function copyToken() {
    if (!revealed) return
    try {
      await navigator.clipboard.writeText(revealed.token)
      setCopied(true)
      toast({ title: "Token copied to clipboard.", variant: "success" })
    } catch {
      toast({ title: "Couldn't copy — copy manually.", variant: "error" })
    }
  }

  return (
    <Dialog
      open={revealed !== null}
      onOpenChange={(o) => {
        if (!o) {
          setCopied(false)
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Token created — copy it now</DialogTitle>
          <DialogDescription>
            This is the only time we&rsquo;ll show the secret. We store only
            its hash, so we can&rsquo;t recover it later. If you lose it,
            revoke the token and create a new one.
          </DialogDescription>
        </DialogHeader>

        {revealed ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-amber-300/50 bg-amber-50 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                Secret token for: {revealed.name}
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-white px-3 py-2 text-xs">
                {revealed.token}
              </pre>
              <Button
                type="button"
                size="sm"
                onClick={copyToken}
                className="mt-2 rounded-xl"
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                {copied ? "Copied" : "Copy to clipboard"}
              </Button>
            </div>

            <div className="rounded-xl border border-border/60 bg-surface-low px-4 py-3 text-sm">
              <p className="font-semibold">How to use it</p>
              <pre className="mt-2 overflow-x-auto text-xs leading-relaxed">
                {`curl https://your-domain.com/api/v1/employees \\
  -H "Authorization: Bearer ${revealed.token}"`}
              </pre>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            onClick={() => {
              setCopied(false)
              onClose()
            }}
            className="rounded-xl"
          >
            I&rsquo;ve copied it — close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
