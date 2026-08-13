"use client"

import { useState, useTransition, type FormEvent } from "react"
import { Eye, EyeOff, Loader2, Lock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { DownloadPayslipButton } from "@/components/payroll/download-payslip-button"
import { PrintPayslipButton } from "@/components/admin/print-payslip-button"
import {
  PayslipDetailBody,
  type PayslipDetailData,
} from "@/components/payroll/payslip-detail-body"

type RevealResult =
  | ({ ok: true } & PayslipDetailData)
  | { ok: false; reason: "bad-password" | "not-found" }

/**
 * Privacy gate for the employee payslip view. Renders a password prompt
 * instead of the payslip; on a correct password the reveal action hands
 * back the figures and we render them client-side. State is local and
 * un-persisted, so navigating away and re-opening any payslip prompts
 * again — the "re-enter every time" behaviour the customer asked for.
 *
 * The salary figures are never in the page payload before unlock: the
 * server page ships only a lightweight header, and `action` (a server
 * action passed down from the page) returns the body only after it has
 * verified the password server-side.
 */
export function PayslipGate({
  payslipId,
  action,
}: {
  payslipId: string
  action: (payslipId: string, password: string) => Promise<RevealResult>
}) {
  const [password, setPassword] = useState("")
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<PayslipDetailData | null>(null)
  const [pending, startTransition] = useTransition()

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const res = await action(payslipId, password)
      if (res.ok) {
        setRevealed({ payslip: res.payslip, run: res.run })
        setPassword("")
      } else {
        setError(
          res.reason === "bad-password"
            ? "Incorrect password. Please try again."
            : "This payslip is unavailable.",
        )
      }
    })
  }

  if (revealed) {
    return (
      <div className="space-y-6 print:space-y-3" id="payslip-print-root">
        <div className="flex items-center justify-end gap-2 print:hidden">
          <DownloadPayslipButton payslipId={payslipId} />
          <PrintPayslipButton />
        </div>
        <PayslipDetailBody payslip={revealed.payslip} run={revealed.run} />
      </div>
    )
  }

  return (
    <Card className="mx-auto max-w-md print:hidden">
      <CardHeader className="items-center text-center">
        <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-primary">
          <Lock className="h-5 w-5" />
        </div>
        <CardTitle className="text-base">This payslip is protected</CardTitle>
        <CardDescription>
          For your privacy, enter your account password to view your payslip.
          You&apos;ll be asked again each time you open one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="payslip-password">Account password</Label>
            <div className="relative">
              <Input
                id="payslip-password"
                type={show ? "text" : "password"}
                autoFocus
                autoComplete="current-password"
                value={password}
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setPassword(e.target.value)
                  if (error) setError(null)
                }}
                placeholder="Your login password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={show ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={pending || !password}
          >
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Verifying…
              </>
            ) : (
              "View payslip"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
