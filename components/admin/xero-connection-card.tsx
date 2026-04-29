"use client"

import { useState } from "react"
import { Building2, CircleAlert, Link2, Loader2, Unplug } from "lucide-react"

import { disconnectXeroAction } from "@/app/(admin)/admin/settings/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/ui/toaster"
import type { XeroConnectionInfo, XeroConnectionSummary } from "@/modules/organization/domain/models"

function formatTimestamp(value?: string) {
  if (!value) return null
  return new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function ConnectionRow({ connection }: { connection: XeroConnectionInfo }) {
  const { toast } = useToast()
  const [disconnecting, setDisconnecting] = useState(false)
  const connectedAt = formatTimestamp(connection.connectedAt)

  async function handleDisconnect() {
    if (!confirm(`Disconnect "${connection.tenantName}"? This cannot be undone.`)) return
    setDisconnecting(true)
    const result = await disconnectXeroAction(connection.id)
    setDisconnecting(false)
    if (result.ok) {
      toast({ title: result.message, variant: "success" })
    } else {
      toast({ title: result.message, variant: "error" })
    }
  }

  return (
    <div className="flex items-start justify-between gap-4 rounded-[20px] border border-border/70 bg-surface-low p-4">
      <div>
        <p className="flex items-center gap-2 font-bold text-foreground">
          <Building2 className="h-4 w-4 text-primary" />
          {connection.tenantName}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {[connection.tenantType, connection.tenantId].filter(Boolean).join(" · ")}
        </p>
        {connectedAt ? (
          <p className="mt-0.5 text-xs text-muted-foreground">Connected: {connectedAt}</p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={handleDisconnect}
        disabled={disconnecting}
      >
        {disconnecting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            <Unplug className="mr-1.5 h-4 w-4" />
            Disconnect
          </>
        )}
      </Button>
    </div>
  )
}

export function XeroConnectionCard({
  connection,
  status,
  reason,
}: {
  connection: XeroConnectionSummary
  status?: string
  reason?: string
}) {
  const hasConnections = connection.connections.length > 0

  return (
    <Card className="hidden lg:block">
      <CardHeader className="flex-row items-start justify-between gap-6">
        <div>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Link2 className="h-5 w-5 text-primary" />
            Xero connection
          </CardTitle>
          {hasConnections ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Connected for this company
            </p>
          ) : null}
        </div>

        {!hasConnections ? (
          <Button asChild className="shrink-0 rounded-2xl">
            <a href="/api/xero/connect">Connect this company to Xero</a>
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-3">
          {hasConnections ? (
            connection.connections.map((conn) => (
              <ConnectionRow key={conn.id} connection={conn} />
            ))
          ) : (
            <div className="rounded-[24px] bg-surface-low p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Connection status
              </p>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                This company is not connected to Xero yet.
              </p>
            </div>
          )}
        </div>

        <div className="rounded-[24px] bg-surface-low p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Readiness
          </p>

          {connection.configured ? (
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Xero OAuth credentials and the default bill account code are configured.
            </p>
          ) : (
            <div className="mt-3 flex gap-3 rounded-2xl border border-amber-300/50 bg-amber-50/70 p-4 text-sm text-amber-900">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Missing environment variables: {connection.missingConfig.join(", ")}.</p>
            </div>
          )}

          {status === "connected" ? (
            <p className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              Xero connected successfully for this company.
            </p>
          ) : null}

          {status === "misconfigured" ? (
            <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Xero connect is not ready yet because required environment variables are missing.
            </p>
          ) : null}

          {status === "invalid-state" ? (
            <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Xero callback state did not match. Try connecting again.
            </p>
          ) : null}

          {status === "no-tenant" ? (
            <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Xero authorized the app, but no organisation was returned for this user.
            </p>
          ) : null}

          {status === "multiple-tenants" ? (
            <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              More than one Xero organisation was selected during sign-in. Please connect again and
              select only one organisation.
            </p>
          ) : null}

          {status === "error" && reason ? (
            <p className="mt-4 rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {reason}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
