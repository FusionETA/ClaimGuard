"use client"

import { useActionState, useEffect, useState } from "react"
import { KeyRound, LoaderCircle } from "lucide-react"

import { changePasswordAction } from "@/app/login/actions"
import { initialChangePasswordFormState } from "@/app/login/form-state"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToastOnAction } from "@/components/ui/toaster"

/**
 * Trigger + Dialog for changing the signed-in user's password.
 * Sits in the avatar area next to `<LogoutButton />`. Hidden when the
 * session was minted via SSO (those accounts have no useful password —
 * see lib/auth/authenticate.buildSessionUserForEmail).
 *
 * The dialog auto-closes on success (toast surfaces the result via the
 * existing useToastOnAction wiring).
 *
 * Multi-org: when `hasMultipleCompanies` is true the dialog surfaces
 * a small notice explaining that the password change applies across
 * every company this user works at (there's only one User row / one
 * password for auth). Without it, an employee at two companies might
 * expect the change to only affect the currently-picked company.
 */
export function ChangePasswordButton({
  hasMultipleCompanies = false,
  /// Force a "Change password" text label next to the icon. Default
  /// `false` keeps the icon-only round button used inline in the
  /// header pill. Set to `true` where the action should read as a
  /// full-width labelled row.
  showLabel = false,
}: {
  hasMultipleCompanies?: boolean
  showLabel?: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title="Change password"
        className={
          showLabel
            ? "shrink-0 rounded-full"
            : "h-9 w-9 shrink-0 rounded-full p-0"
        }
        aria-label="Change password"
      >
        <KeyRound className="h-4 w-4" />
        {showLabel ? <span>Change password</span> : null}
      </Button>

      <ChangePasswordDialog
        open={open}
        onOpenChange={setOpen}
        hasMultipleCompanies={hasMultipleCompanies}
      />
    </>
  )
}

export function ChangePasswordDialog({
  open,
  onOpenChange,
  hasMultipleCompanies = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  hasMultipleCompanies?: boolean
}) {
  const [state, action, pending] = useActionState(
    changePasswordAction,
    initialChangePasswordFormState,
  )
  // Mirror the action state into the toast hook's required shape. For
  // idle / error-without-message we pass status "idle" with an empty
  // message so the hook stays quiet.
  useToastOnAction(
    state.status === "success"
      ? { status: "success" as const, message: state.message ?? "Password updated." }
      : state.status === "error" && state.message
        ? { status: "error" as const, message: state.message }
        : { status: "idle" as const, message: "" },
  )

  // Close the dialog automatically on success.
  useEffect(() => {
    if (state.status === "success") onOpenChange(false)
  }, [state.status, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="bottom-auto flex max-h-[calc(100dvh-2rem)] w-[min(92vw,440px)] flex-col overflow-y-auto px-5 pb-5 pt-5 sm:max-h-none sm:max-w-[440px] sm:px-6 sm:pb-6 sm:pt-6"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>
              Enter your current password, then choose a new one.
            </DialogDescription>
          </DialogHeader>

          {hasMultipleCompanies ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              You&apos;re an active employee at more than one company on
              AltomateHR. Changing your password here changes it for{" "}
              <strong>every company</strong> you sign in to — there&apos;s
              one shared login across all of them.
            </div>
          ) : null}

          <form action={action} className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="currentPassword">Current password</Label>
              <Input
                id="currentPassword"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                aria-invalid={Boolean(state.errors?.currentPassword)}
                required
              />
              {state.errors?.currentPassword ? (
                <p className="text-xs text-destructive">
                  {state.errors.currentPassword}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="newPassword">New password</Label>
              <Input
                id="newPassword"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={8}
                placeholder="At least 8 characters"
                aria-invalid={Boolean(state.errors?.newPassword)}
                required
              />
              {state.errors?.newPassword ? (
                <p className="text-xs text-destructive">
                  {state.errors.newPassword}
                </p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirmPassword">Confirm new password</Label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                minLength={8}
                aria-invalid={Boolean(state.errors?.confirmPassword)}
                required
              />
              {state.errors?.confirmPassword ? (
                <p className="text-xs text-destructive">
                  {state.errors.confirmPassword}
                </p>
              ) : null}
            </div>

            {state.message && state.status === "error" ? (
              <p className="rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {state.message}
              </p>
            ) : null}

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? (
                  <>
                    <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                    Updating…
                  </>
                ) : (
                  "Update password"
                )}
              </Button>
            </DialogFooter>
          </form>
      </DialogContent>
    </Dialog>
  )
}
