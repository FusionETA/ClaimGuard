"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/**
 * Extra props for our DialogContent on top of Radix's defaults.
 *
 * `allowDismissOutside` — opt-IN to Radix's stock behaviour where the
 * dialog closes on backdrop click + Escape key. We default this to
 * `false` because almost every dialog in this app contains a form,
 * and clicking outside (or fat-fingering Escape) silently throws
 * away whatever the user has typed. The visible `X` close button
 * still works either way — it goes through `DialogPrimitive.Close`,
 * which fires `onOpenChange(false)` directly without routing through
 * `onInteractOutside` / `onEscapeKeyDown`.
 *
 * Pass `allowDismissOutside` on the rare info-only dialog (no form,
 * no destructive consequence) where backdrop-to-dismiss is genuinely
 * the natural UX.
 */
type DialogContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> & {
  allowDismissOutside?: boolean
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(
  (
    {
      className,
      children,
      allowDismissOutside = false,
      onInteractOutside,
      onEscapeKeyDown,
      ...props
    },
    ref,
  ) => (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        onInteractOutside={(event) => {
          // Block backdrop-click dismissal unless the caller opted in.
          // We still fire the caller's handler (if any) so dialogs that
          // want to react to the attempted dismissal can do so.
          if (!allowDismissOutside) event.preventDefault()
          onInteractOutside?.(event)
        }}
        onEscapeKeyDown={(event) => {
          // Same logic for Escape: prevent accidental dismissal of
          // forms. The X close button + any custom Cancel buttons are
          // always available.
          if (!allowDismissOutside) event.preventDefault()
          onEscapeKeyDown?.(event)
        }}
        className={cn(
          "fixed inset-x-4 top-[max(16px,env(safe-area-inset-top))] bottom-[max(16px,env(safe-area-inset-bottom))] z-50 grid w-auto gap-4 overflow-y-auto rounded-[32px] border border-white/40 bg-card/95 p-6 shadow-panel backdrop-blur-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:bottom-auto sm:left-[50%] sm:top-[50%] sm:w-[min(92vw,880px)] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:overflow-visible sm:p-8",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-5 top-5 rounded-full p-2 text-muted-foreground transition-colors hover:bg-surface-low hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  ),
)
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-2 text-left", className)} {...props} />
)
DialogHeader.displayName = "DialogHeader"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("font-headline text-2xl font-black tracking-tight text-foreground", className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
