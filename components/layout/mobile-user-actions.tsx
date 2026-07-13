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
  //
  // IMPORTANT: exempt clicks that land inside any `[role="dialog"]`
  // (Radix Dialog sets this on DialogContent). Change Password /
  // Switch Company open a dialog PORTALED to document.body — not
  // inside `containerRef`. Without this check, tapping the input
  // fields inside the open dialog looks like an outside-click,
  // closes the menu, unmounts the ChangePasswordButton (or its
  // sibling), and destroys the dialog's `useState(open)`. Net
  // effect: dialog vanishes the moment the user tries to type.
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent | TouchEvent) {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (containerRef.current?.contains(target)) return
      if (target.closest?.('[role="dialog"]')) return
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
          // Auto-close the menu on any child click SO the user gets
          // one-tap navigation for Logout (form → submit → next page).
          //
          // BUT dialog triggers (SwitchCompany, ChangePassword) can't
          // close the menu — closing unmounts the trigger, which
          // destroys its dialog `useState(open)` before the dialog
          // gets a chance to render, so the dialog pops open and
          // instantly disappears. For those rows, we mark the wrapper
          // with `data-menu-keep-open` and skip the close.
          //
          // Once the user is done with the dialog, they can dismiss
          // the still-open menu with an outside tap or Escape — both
          // wired in the effect above.
          onClick={(event) => {
            const target = event.target as HTMLElement | null
            if (target?.closest("[data-menu-keep-open]")) return
            setTimeout(close, 0)
          }}
        >
          {hasMultipleCompanies ? (
            <div data-menu-keep-open>
              <SwitchCompanyButton showLabel />
            </div>
          ) : null}
          <div data-menu-keep-open>
            <ChangePasswordButton
              hasMultipleCompanies={hasMultipleCompanies}
              showLabel
            />
          </div>
          <LogoutButton showLabel />
        </div>
      ) : null}
    </div>
  )
}
