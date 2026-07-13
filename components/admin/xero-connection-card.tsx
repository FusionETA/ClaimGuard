"use client"

import { useState } from "react"
import { Building2, CircleAlert, Link2, Loader2, RefreshCw, ShieldCheck, Unplug } from "lucide-react"

import { disconnectXeroAction } from "@/app/(admin)/admin/settings/actions"
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
  const [confirmOpen, setConfirmOpen] = useState(false)
  const connectedAt = formatTimestamp(connection.connectedAt)

  async function handleConfirmDisconnect() {
    setDisconnecting(true)
    const result = await disconnectXeroAction(connection.id)
    setDisconnecting(false)
    setConfirmOpen(false)
    if (result.ok) {
      toast({ title: result.message, variant: "success" })
    } else {
      toast({ title: result.message, variant: "error" })
    }
  }

  return (
    <>
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
          {connection.requiresReauth ? (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900">
              <ShieldCheck className="h-3 w-3" />
              Permission update required — click to re-authorize.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Re-run the OAuth flow without disconnecting. When
              `requiresReauth` is true (Xero pushed a scope change and
              our stored token no longer covers it) the button gets
              the amber "Update permissions" treatment; otherwise it's
              a neutral "Reconnect" that admins can use to swap the
              signed-in Xero user, refresh a stale refresh token, or
              re-establish a connection after revoking access on the
              Xero side. Same href either way. */}
          <Button
            asChild
            type="button"
            variant="outline"
            size="sm"
            className={
              connection.requiresReauth
                ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 hover:text-amber-950"
                : undefined
            }
          >
            <a href="/api/xero/connect">
              {connection.requiresReauth ? (
                <>
                  <ShieldCheck className="mr-1.5 h-4 w-4" />
                  Update permissions
                </>
              ) : (
                <>
                  <RefreshCw className="mr-1.5 h-4 w-4" />
                  Reconnect
                </>
              )}
            </a>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmOpen(true)}
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
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!disconnecting) setConfirmOpen(open)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Unplug className="h-5 w-5 text-destructive" />
              Disconnect {connection.tenantName}?
            </DialogTitle>
            <DialogDescription>
              This removes AltomateHR&rsquo;s authorization to access your Xero data and clears the
              local copies we keep for routing claims and approvals. Your data <em>inside Xero</em>{" "}
              is not touched.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 text-sm">
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
              <p className="font-semibold text-destructive">
                These get deleted from AltomateHR
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-foreground/80">
                <li>Chart of accounts synced from this Xero org (selectable list, banks, mileage flags, spend limits)</li>
                <li>Projects synced from this Xero org</li>
                <li>Project Managers assigned to those projects</li>
                <li>Project holidays attached to those projects</li>
                <li>Teams under those projects, plus everyone&rsquo;s team membership and approval chain steps tied to those teams</li>
                <li>Employees&rsquo; project assignments under those projects</li>
              </ul>
            </div>

            <div className="rounded-2xl border border-amber-300/50 bg-amber-50/70 p-4">
              <p className="font-semibold text-amber-900">These survive but lose their reference</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-amber-900/90">
                <li>
                  <span className="font-medium">Claims</span> — historical claims stay, but
                  their chart-of-account and project links are nulled out
                </li>
                <li>
                  <span className="font-medium">Attendance records</span> — kept, project link
                  nulled out
                </li>
                <li>
                  <span className="font-medium">Receipts uploaded to Xero Files</span> — the file
                  reference stays on the claim row but the proxy view will fail without a Xero
                  connection (locally-stored receipts are unaffected)
                </li>
                <li>
                  <span className="font-medium">Employee profiles</span> — their Xero connection
                  link is nulled out (everything else stays)
                </li>
              </ul>
            </div>

            <p className="text-xs text-muted-foreground">
              You can reconnect this Xero org any time and re-import the chart of accounts and
              projects. You will need to re-set up teams, project managers, and assignments though,
              because those are tied to the deleted project rows.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={disconnecting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleConfirmDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Disconnecting…
                </>
              ) : (
                <>
                  <Unplug className="mr-2 h-4 w-4" />
                  Disconnect
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
