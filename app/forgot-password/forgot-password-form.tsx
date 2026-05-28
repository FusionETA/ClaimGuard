"use client"

import Link from "next/link"
import { useActionState } from "react"
import { LoaderCircle } from "lucide-react"

import { requestPasswordResetAction } from "@/app/forgot-password/actions"
import { initialRequestCodeFormState } from "@/app/forgot-password/form-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(
    requestPasswordResetAction,
    initialRequestCodeFormState,
  )

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="email">Work email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@company.com"
          defaultValue={state?.email ?? ""}
          required
        />
      </div>

      {state?.message ? (
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
            Sending…
          </>
        ) : (
          "Send reset code"
        )}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Remembered it?{" "}
        <Link href="/login" className="font-semibold text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  )
}
