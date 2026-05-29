"use client"

import { useActionState } from "react"

import { unlockAction } from "@/app/internal/api-scopes/actions"
import { initialInternalUnlockState } from "@/app/internal/api-scopes/form-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * Tiny password form. Single input + submit. On match, the server
 * action sets the unlock cookie and revalidates the page so the
 * editor renders without a hard navigation.
 */
export function UnlockForm() {
  const [state, formAction, pending] = useActionState(
    unlockAction,
    initialInternalUnlockState,
  )

  return (
    <form action={formAction} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="internal-password" className="text-xs">
          Password
        </Label>
        <Input
          id="internal-password"
          name="password"
          type="password"
          required
          autoFocus
          autoComplete="off"
          disabled={pending}
        />
      </div>
      {state.status === "error" ? (
        <p className="text-xs font-medium text-destructive">{state.message}</p>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Checking…" : "Unlock"}
      </Button>
    </form>
  )
}
