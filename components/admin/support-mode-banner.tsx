"use client"

import { exitSupportModeAction } from "@/app/(admin)/admin/support/actions"
import { Button } from "@/components/ui/button"

/**
 * Persistent yellow banner rendered at the top of the admin shell
 * when a superadmin is currently acting inside a DIFFERENT org
 * (i.e. `activeOrganizationId !== session.organizationId` AND
 * `session.isSuperadmin`). Keeps the support user aware they're
 * NOT in their own tenant, and gives them one-click exit.
 *
 * Rendered by `admin-shell.tsx`, which decides visibility based on
 * the session it already has in scope — no client-side session
 * refetch needed.
 */
export function SupportModeBanner({
  targetOrgName,
  targetOrgOwnerEmail,
}: {
  targetOrgName: string | null
  targetOrgOwnerEmail?: string | null
}) {
  return (
    <div className="border-b border-yellow-400 bg-yellow-100 px-4 py-2 text-yellow-950 dark:border-yellow-500/50 dark:bg-yellow-900/40 dark:text-yellow-100 print:hidden">
      <div className="container flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col text-sm">
          <span className="font-semibold">
            🛠 Support mode
          </span>
          <span className="text-xs opacity-90">
            Acting as{" "}
            <span className="font-medium">
              {targetOrgName ?? "(unknown org)"}
            </span>
            {targetOrgOwnerEmail ? (
              <>
                {" "}
                · owner {targetOrgOwnerEmail}
              </>
            ) : null}
            . Your actions appear as &quot;System (Support)&quot; in this
            org&apos;s audit log; the real actor is tracked internally.
          </span>
        </div>
        <form action={exitSupportModeAction}>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="border-yellow-500/70 bg-white/70 text-yellow-950 hover:bg-white dark:border-yellow-400/60 dark:bg-yellow-950/40 dark:text-yellow-50 dark:hover:bg-yellow-950/70"
          >
            Exit support mode
          </Button>
        </form>
      </div>
    </div>
  )
}
