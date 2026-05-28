"use client"

import Link from "next/link"
import { useActionState } from "react"
import { LoaderCircle } from "lucide-react"

import { resetPasswordAction } from "@/app/forgot-password/actions"
import { initialResetPasswordFormState } from "@/app/forgot-password/form-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function VerifyForm({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState(
    resetPasswordAction,
    initialResetPasswordFormState,
  )

  return (
    <form action={formAction} className="space-y-5">
      {/* Email is carried via the URL — pin it as a hidden field so the
          action sees it. We also render it read-only above so the user
          can confirm they're resetting the right account. */}
      <input type="hidden" name="email" value={email} />

      <div className="rounded-2xl border border-border/60 bg-muted/30 px-4 py-3 text-sm">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Resetting password for
        </p>
        <p className="mt-0.5 font-semibold text-foreground">{email}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="code">6-digit code</Label>
        <Input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          minLength={6}
          pattern="\d{6}"
          placeholder="123456"
          defaultValue={state?.values?.code ?? ""}
          aria-invalid={Boolean(state?.errors?.code)}
          className="text-center text-lg tracking-[0.4em]"
          required
        />
        {state?.errors?.code ? (
          <p className="text-sm text-destructive">{state.errors.code}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          placeholder="At least 8 characters"
          aria-invalid={Boolean(state?.errors?.newPassword)}
          required
        />
        {state?.errors?.newPassword ? (
          <p className="text-sm text-destructive">{state.errors.newPassword}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          minLength={8}
          placeholder="Re-enter your new password"
          aria-invalid={Boolean(state?.errors?.confirmPassword)}
          required
        />
        {state?.errors?.confirmPassword ? (
          <p className="text-sm text-destructive">
            {state.errors.confirmPassword}
          </p>
        ) : null}
      </div>

      {state?.message && state.status === "error" ? (
        <p className="rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {state.message}
        </p>
      ) : null}

      <Button
        type="submit"
        size="lg"
        className="w-full justify-center rounded-2xl"
        disabled={pending}
      >
        {pending ? (
          <>
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
            Updating…
          </>
        ) : (
          "Reset password"
        )}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Didn&apos;t get the code?{" "}
        <Link
          href="/forgot-password"
          className="font-semibold text-primary hover:underline"
        >
          Request a new one
        </Link>
      </p>
    </form>
  )
}
