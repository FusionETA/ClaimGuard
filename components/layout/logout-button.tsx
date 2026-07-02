"use client"

import { useTransition } from "react"
import { LogOut } from "lucide-react"

import { logoutAction } from "@/app/login/actions"
import { Button } from "@/components/ui/button"
import { unsubscribeFromPushNotifications } from "@/lib/push-notifications"

/**
 * Logout button shared by the employee + admin shells.
 *
 * Wraps the server action so that BEFORE the session is cleared the
 * device's push subscription is released (both the DB row via
 * /api/push/unsubscribe and the OS-level pushManager subscription).
 * Without this step, the device keeps receiving notifications for the
 * previous account — see lib/push-notifications.ts for the rationale.
 *
 * Falls back to the plain logoutAction if anything blows up during the
 * client-side unsubscribe — the server action also wipes the DB row
 * as a belt-and-braces fallback.
 */
export function LogoutButton({
  /// Force the "Log out" text label to show at every breakpoint.
  /// Default `false` keeps the header's icon-only rendering. Set to
  /// `true` inside the mobile popover menu so the row reads as a
  /// full-width labelled action.
  showLabel = false,
}: {
  showLabel?: boolean
} = {}) {
  const [pending, startTransition] = useTransition()

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return

    startTransition(async () => {
      // Best-effort client-side cleanup. Any failure is swallowed
      // inside the helper; the server action will catch up.
      await unsubscribeFromPushNotifications().catch(() => null)
      // Server action — clears the session cookie, deletes any
      // remaining PushSubscription rows for the user, then redirects.
      await logoutAction()
    })
  }

  return (
    <form onSubmit={handleSubmit} suppressHydrationWarning>
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="rounded-full"
        disabled={pending}
      >
        <LogOut className="h-4 w-4" />
        <span className={showLabel ? "inline" : "hidden sm:inline"}>
          {pending ? "Signing out…" : "Log out"}
        </span>
      </Button>
    </form>
  )
}
