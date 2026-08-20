"use client"

import { useTransition } from "react"
import { Mail } from "lucide-react"

import {
  emailPayslipAction,
  emailRunPayslipsAction,
} from "@/app/(admin)/admin/payroll/runs/[id]/actions"
import { Button } from "@/components/ui/button"
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog"
import { useToast } from "@/components/ui/toaster"

/**
 * Per-row "Email" action — sends one employee their payslip as a
 * password-protected PDF. Shown only on SUBMITTED runs.
 */
export function EmailPayslipButton(props: { payslipId: string }) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1 px-2 text-xs"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await emailPayslipAction({ payslipId: props.payslipId })
          toast({
            title: result.message,
            variant: result.ok ? "success" : "error",
          })
        })
      }
    >
      <Mail className="h-3.5 w-3.5" />
      {pending ? "Emailing…" : "Email"}
    </Button>
  )
}

/**
 * Header "Email payslips" action — emails every employee on the run their
 * payslip. Guarded by a confirm dialog since it's a bulk send. Each
 * failure surfaces as its own toast so the admin knows exactly who to
 * follow up with.
 */
export function EmailAllPayslipsButton(props: { runId: string; count: number }) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()

  const run = () =>
    startTransition(async () => {
      const result = await emailRunPayslipsAction({ runId: props.runId })
      toast({
        title: result.message,
        variant: result.ok ? "success" : "error",
      })
      for (const failure of result.failures.slice(0, 8)) {
        toast({ title: failure, variant: "error" })
      }
    })

  return (
    <ConfirmActionDialog
      title="Email all payslips?"
      description={`Each of the ${props.count} employee${
        props.count === 1 ? "" : "s"
      } on this run will be emailed their payslip as a password-protected PDF (opens with their IC number).`}
      confirmLabel="Email all"
      triggerLabel="Email payslips"
      triggerVariant="outline"
      triggerSize="sm"
      pendingLabel="Emailing…"
      pending={pending}
      onConfirm={run}
    />
  )
}
