"use client"

import { useState, useTransition, type FormEvent } from "react"
import { KeyRound, Loader2, TriangleAlert } from "lucide-react"

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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/toaster"
import { setEmployeePasswordAction } from "@/app/(admin)/admin/payroll/employees/[id]/actions"

/**
 * Admin action: overwrite an employee's login password with one the
 * admin types in. Replaces the old "reset to the DOB default" button —
 * the admin now sets a specific password (e.g. to hand a fresh one to a
 * returning employee). Rendered on the per-employee Personal tab.
 *
 * The password is verified/hashed server-side (min 8 chars, matching the
 * forgot-password policy) and never echoed back — the admin typed it, so
 * there's nothing to reveal. All guardrails (no self-change, no owner,
 * org scope, audit) live in the service.
 */
export function SetEmployeePasswordButton(props: {
  userId: string
  employeeName: string
  employeeEmail: string
}) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function handleClose(next: boolean) {
    setOpen(next)
    if (!next) {
      setPassword("")
      setConfirm("")
      setError(null)
      setShow(false)
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError("Password must be at least 8 characters.")
      return
    }
    if (password !== confirm) {
      setError("Passwords do not match.")
      return
    }
    startTransition(async () => {
      const result = await setEmployeePasswordAction({
        userId: props.userId,
        newPassword: password,
      })
      if (result.ok) {
        toast({
          title: `Password updated for ${props.employeeName}.`,
          variant: "success",
        })
        handleClose(false)
      } else {
        setError(result.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5">
          <KeyRound className="h-3.5 w-3.5" />
          Overwrite password
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-4 w-4 text-amber-500" />
              Overwrite password
            </DialogTitle>
            <DialogDescription>
              Set a new login password for{" "}
              <span className="font-semibold text-foreground">
                {props.employeeName}
              </span>{" "}
              ({props.employeeEmail}). Their current password stops working
              immediately — share the new one with them securely.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 pl-1">
            <div className="space-y-1.5">
              <Label htmlFor="ovw-pw">New password</Label>
              <Input
                id="ovw-pw"
                type={show ? "text" : "password"}
                value={password}
                autoComplete="new-password"
                autoFocus
                onChange={(e) => {
                  setPassword(e.target.value)
                  if (error) setError(null)
                }}
                placeholder="At least 8 characters"
                aria-invalid={error ? true : undefined}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ovw-pw2">Confirm password</Label>
              <Input
                id="ovw-pw2"
                type={show ? "text" : "password"}
                value={confirm}
                autoComplete="new-password"
                onChange={(e) => {
                  setConfirm(e.target.value)
                  if (error) setError(null)
                }}
                placeholder="Re-enter the password"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={show}
                onChange={(e) => setShow(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              Show password
            </label>
            {error ? (
              <p className="text-sm font-medium text-destructive">{error}</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => handleClose(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !password || !confirm}>
              {pending ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Set password"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
