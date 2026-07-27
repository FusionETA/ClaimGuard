"use client"

import Link from "next/link"
import type { Route } from "next"
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { CheckCircle2, CircleAlert, X } from "lucide-react"

import { cn } from "@/lib/utils"

type ToastVariant = "success" | "error"

type ToastAction = {
  label: string
  href: string
}

type Toast = {
  id: number
  title: string
  variant: ToastVariant
  /// When present, renders a link below the title. Toasts with an
  /// action stay on-screen 10s (instead of the default 3s) so admins
  /// have time to actually click.
  action?: ToastAction
}

type ToastContextValue = {
  toast: (input: {
    title: string
    variant?: ToastVariant
    action?: ToastAction
  }) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToasterProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const toast = useCallback(
    ({
      title,
      variant = "success",
      action,
    }: {
      title: string
      variant?: ToastVariant
      action?: ToastAction
    }) => {
      const id = Date.now() + Math.floor(Math.random() * 1000)

      setToasts((current) => [...current, { id, title, variant, action }])

      // Longer window (10s) when the toast is actionable so the user
      // has time to click; still 3s for plain notifications.
      window.setTimeout(
        () => {
          dismiss(id)
        },
        action ? 10_000 : 3_000,
      )
    },
    [dismiss]
  )

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* Toasts are hidden below lg — on phones the fixed bottom-right
          card obscures the bottom nav bar and never looked good against
          the shell. Server-action toasts still fire (the useEffect runs
          on all viewports); the viewport just doesn't render them.
          Reintroduce with a mobile-first design if we want mobile
          feedback back. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] hidden w-[calc(100vw-2rem)] max-w-[360px] flex-col gap-3 sm:bottom-6 sm:right-6 lg:flex">
        {toasts.map((item) => (
          <div
            key={item.id}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-2xl border bg-card/95 px-4 py-3 shadow-panel backdrop-blur-xl",
              item.variant === "success"
                ? "border-primary/20"
                : "border-destructive/20"
            )}
          >
            <div
              className={cn(
                "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                item.variant === "success"
                  ? "bg-primary/12 text-primary"
                  : "bg-destructive/10 text-destructive"
              )}
            >
              {item.variant === "success" ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <CircleAlert className="h-4 w-4" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">{item.title}</p>
              {item.action ? (
                <Link
                  href={item.action.href as Route}
                  onClick={() => dismiss(item.id)}
                  className="mt-1 inline-block text-xs font-semibold text-primary underline-offset-2 hover:underline"
                >
                  {item.action.label}
                </Link>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              className="rounded-full p-1 text-muted-foreground transition hover:bg-surface-low hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)

  if (!context) {
    throw new Error("useToast must be used within ToasterProvider")
  }

  return context
}

/**
 * Convenience hook that fires a toast every time a server-action's
 * state transitions — including back-to-back errors with the same
 * message. Removes the boilerplate
 *
 *   useEffect(() => {
 *     if (state.status === "success") toast({ ... })
 *     if (state.status === "error")   toast({ ... })
 *   }, [state])
 *
 * which used to be repeated for every `useActionState` call. Important:
 * the dependency MUST be the state reference (not just `state.status`
 * / `state.message`) so a second submission that produces the same
 * shape still re-fires.
 */
export function useToastOnAction(state: {
  status: "idle" | "success" | "error"
  message: string
}) {
  const { toast } = useToast()

  useEffect(() => {
    if (state.status === "success") {
      toast({ title: state.message, variant: "success" })
    } else if (state.status === "error") {
      toast({ title: state.message, variant: "error" })
    }
    // Depend on the STATE REFERENCE, not on status+message primitives.
    //
    // Why: useActionState returns a brand-new state object after every
    // submission. With the old `[state.status, state.message]` deps a
    // second submission that produced the same status + message (e.g.
    // the user fixes one validation error, hits submit, hits another
    // copy of the same error) wouldn't re-fire the toast — both
    // primitives were unchanged so React skipped the effect, and the
    // user perceived the submit button as broken. Depending on the
    // reference catches every submission because useActionState always
    // returns a fresh object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])
}
