"use client"

import { MoreVertical } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { ChangePasswordButton } from "@/components/layout/change-password-button"
import { LogoutButton } from "@/components/layout/logout-button"
import { SwitchCompanyButton } from "@/components/layout/switch-company-button"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Mobile-only collapse for the header's user-action trio (Switch
 * Company, Change Password, Log out). On desktop (`sm+`) the three
 * buttons render inline inside the avatar pill; on mobile they cram
 * against the bell and CZ avatar and there isn't room. This component
 * replaces them under `sm` with a single 3-dot button that expands
 * into a small floating card with the same three actions as full-
 * width rows (icon + label).
 *
 * The underlying buttons are reused verbatim — they carry their own
 * pending state, dialogs, aria labels, etc. — so behaviour stays
 * identical across the two viewports.
 */
export function MobileUserActions({
  hasMultipleCompanies,
}: {
  hasMultipleCompanies?: boolean
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => setOpen(false), [])

  // Click-outside + Escape to dismiss. Uses `mousedown` so the menu
  // closes on the SAME tap that clicks another button in the header,
  // avoiding a follow-up flash of the still-open menu.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Node | null
      if (target && containerRef.current?.contains(target)) return
      close()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close()
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("touchstart", onPointerDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("touchstart", onPointerDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, close])

  return (
    <div ref={containerRef} className="relative sm:hidden">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title="More actions"
        aria-label="More actions"
        aria-expanded={open}
        aria-haspopup="menu"
        className="h-9 w-9 shrink-0 rounded-full p-0"
      >
        <MoreVertical className="h-4 w-4" />
      </Button>

      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute right-0 top-[calc(100%+8px)] z-40 min-w-[204px]",
            "rounded-2xl border border-border/60 bg-card p-2 shadow-panel",
            // Each child (`SwitchCompanyButton`, `LogoutButton`'s form,
            // `ChangePasswordButton`) exposes its button as the first
            // element — force it to full width + left-aligned + a
            // rounded row look so all three read as a proper menu.
            "flex flex-col gap-1",
            "[&_button]:w-full [&_button]:justify-start",
            "[&_button]:rounded-xl [&_button]:px-3",
            "[&_form]:w-full",
          )}
          // Defer the close by one tick. React's synthetic events
          // bubble child → parent, so a naive `onClick={close}` here
          // fires AFTER the child button's onClick — which reads fine
          // in isolation. BUT for children that rely on the browser's
          // DEFAULT action (form submit for LogoutButton, opening a
          // dialog for ChangePasswordButton), React commits our
          // `setOpen(false)` synchronously and unmounts the whole
          // menu before the browser fires those defaults. The result
          // is the form vanishes before it can submit / the dialog
          // state is destroyed before it can render. Punting the
          // close to the next macrotask lets the browser's default
          // action fire against a still-mounted DOM node first.
          onClick={() => setTimeout(close, 0)}
        >
          {hasMultipleCompanies ? <SwitchCompanyButton showLabel /> : null}
          <ChangePasswordButton
            hasMultipleCompanies={hasMultipleCompanies}
            showLabel
          />
          <LogoutButton showLabel />
        </div>
      ) : null}
    </div>
  )
}
