"use client"

import { useState, useTransition } from "react"
import { Check, Copy, KeyRound, TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useToast } from "@/components/ui/toaster"
import { resetEmployeePasswordAction } from "@/app/(admin)/admin/payroll/employees/[id]/actions"

/**
 * Admin fallback: reset an employee's login password back to the
 * well-known default (`<email><MMDD-of-DOB>`). Rendered on the
 * per-employee Personal tab. Two-stage dialog:
 *
 *   1. Confirm — warning + Cancel / Reset password buttons.
 *   2. Done   — shows the resulting default password with a Copy
 *               button + a Close button. Password is revealed only
 *               after the reset actually landed, so admin knows the
 *               server accepted the change.
 *
 * The success toast is intentionally low-drama — the password is
 * shown inline in the dialog (not in a toast) so it doesn't
 * disappear before the admin has a chance to copy it.
 */
export function ResetEmployeePasswordButton(props: {
  userId: string
  employeeName: string
  employeeEmail: string
}) {
  const [open, setOpen] = useState(false)
  const [newPassword, setNewPassword] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function handleClose(next: boolean) {
    setOpen(next)
    if (!next) {
      // Reset dialog state when it closes so re-opening starts on
      // the confirm stage, not the "done" stage with a stale password.
      setNewPassword(null)
      setCopied(false)
    }
  }

  function handleConfirm() {
    startTransition(async () => {
      const result = await resetEmployeePasswordAction({ userId: props.userId })
      if (result.ok) {
        setNewPassword(result.newPassword)
        toast({ title: result.message, variant: "success" })
      } else {
        toast({ title: result.message, variant: "error" })
        setOpen(false)
      }
    })
  }

  async function copyToClipboard() {
    if (!newPassword) return
    try {
      await navigator.clipboard.writeText(newPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API may be unavailable on some browsers / non-secure
      // contexts. Fall back to a toast that at least lets the admin
      // read the value (still on-screen in the dialog).
      toast({
        title: "Couldn't copy — select the password manually to copy.",
        variant: "error",
      })
    }
  }

  const isDone = newPassword !== null

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5">
          <KeyRound className="h-3.5 w-3.5" />
          Reset password to default
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {isDone ? (
          <>
            <DialogHeader>
              <DialogTitle>Password reset</DialogTitle>
              <DialogDescription>
                {props.employeeName}&apos;s login password has been reset.
                Copy it before closing this dialog — you won&apos;t be
                shown the same value again.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border border-border/70 bg-surface-low p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                New password
              </p>
              <p className="mt-1 break-all font-mono text-sm text-foreground">
                {newPassword}
              </p>
            </div>
            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={copyToClipboard}
                className="gap-1.5"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy password
                  </>
                )}
              </Button>
              <Button type="button" onClick={() => handleClose(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TriangleAlert className="h-4 w-4 text-amber-500" />
                Reset password to default?
              </DialogTitle>
              <DialogDescription>
                Resets the login password for{" "}
                <span className="font-semibold text-foreground">
                  {props.employeeName}
                </span>{" "}
                ({props.employeeEmail}) to the org&apos;s default format
                (email + DOB). Their current password will stop working
                immediately.
                <br />
                <br />
                Use this when an employee has resigned / can&apos;t log
                in and you need to view their portal. The employee&apos;s
                date of birth must be on file.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => handleClose(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={handleConfirm}
              >
                {pending ? "Resetting…" : "Reset password"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
