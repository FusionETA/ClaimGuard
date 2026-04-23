"use client"

import { createContext, useCallback, useContext, useMemo, useState } from "react"
import { CheckCircle2, CircleAlert, X } from "lucide-react"

import { cn } from "@/lib/utils"

type ToastVariant = "success" | "error"

type Toast = {
  id: number
  title: string
  variant: ToastVariant
}

type ToastContextValue = {
  toast: (input: { title: string; variant?: ToastVariant }) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToasterProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const toast = useCallback(
    ({ title, variant = "success" }: { title: string; variant?: ToastVariant }) => {
      const id = Date.now() + Math.floor(Math.random() * 1000)

      setToasts((current) => [...current, { id, title, variant }])

      window.setTimeout(() => {
        dismiss(id)
      }, 3000)
    },
    [dismiss]
  )

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div className="pointer-events-none fixed inset-x-4 bottom-24 z-[100] flex flex-col gap-3 sm:inset-x-auto sm:right-6 sm:top-6 sm:bottom-auto sm:w-[360px]">
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
            <p className="flex-1 text-sm font-semibold text-foreground">{item.title}</p>
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
