"use client"

import Link from "next/link"
import { useActionState } from "react"
import { LoaderCircle } from "lucide-react"

import {
  loginAction,
} from "@/app/login/actions"
import { initialLoginFormState } from "@/app/login/form-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function LoginForm() {
  const initialValues = {
    email: initialLoginFormState.values.email,
  }

  const [state, formAction, pending] = useActionState(loginAction, {
    ...initialLoginFormState,
    values: initialValues,
  })
  const currentValues = {
    email: state?.values?.email ?? initialValues.email,
  }
  const formState = {
    ...initialLoginFormState,
    ...(state ?? {}),
    values: currentValues,
    errors: {
      ...initialLoginFormState.errors,
      ...(state?.errors ?? {}),
    },
  }

  return (
    <form action={formAction} className="space-y-5" suppressHydrationWarning>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          placeholder="your@email.com"
          defaultValue={formState.values.email}
          autoComplete="email"
          aria-invalid={Boolean(formState.errors.email)}
        />
        {formState.errors.email ? (
          <p className="text-sm text-destructive">{formState.errors.email}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          placeholder="Enter your password"
          autoComplete="current-password"
          aria-invalid={Boolean(formState.errors.password)}
        />
        {formState.errors.password ? (
          <p className="text-sm text-destructive">{formState.errors.password}</p>
        ) : null}
      </div>

      {formState.message ? (
        <p className="rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {formState.message}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <Button
          type="submit"
          size="lg"
          className="w-full justify-center rounded-2xl"
          disabled={pending}
        >
          {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          Login
        </Button>
        <Link
          href="/"
          className="inline-flex items-center justify-center rounded-2xl bg-surface-low px-4 py-3 text-sm font-semibold text-muted-foreground transition hover:bg-surface-high hover:text-foreground"
        >
          Back to home
        </Link>
      </div>
    </form>
  )
}
