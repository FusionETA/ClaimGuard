import Link from "next/link"
import type { Route } from "next"
import { redirect } from "next/navigation"
import { ChevronLeft, FileText } from "lucide-react"

import { Button } from "@/components/ui/button"
import { PayslipGate } from "@/components/payroll/payslip-gate"
import { getEmployeePayslipHeader } from "@/modules/payroll/application/services/employee-payroll.service"
import { periodLabel } from "@/modules/payroll/domain/runs"
import { revealPayslipAction } from "./actions"

/**
 * /employee/payslips/[id] — employee-facing payslip detail. Behind a
 * privacy gate: the page ships only a lightweight header (period +
 * identity, no salary figures) and a password prompt. The employee
 * re-enters their account password to reveal the figures, which the
 * reveal action returns only after verifying the password server-side.
 * Asked for again on every open — see `PayslipGate`.
 */
export default async function EmployeePayslipDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const header = await getEmployeePayslipHeader({ payslipId: id })
  if (!header) redirect("/employee/payslips" as Route)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href={"/employee/payslips" as Route}>
              <ChevronLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
          <div className="space-y-0.5">
            <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <FileText className="h-5 w-5 text-primary" />
              {periodLabel(header.periodYear, header.periodMonth)}
            </h1>
            <p className="text-xs text-muted-foreground">
              {header.snapshotName} · {header.snapshotEmployeeId} ·{" "}
              {header.snapshotPosition ?? "—"}
            </p>
          </div>
        </div>
      </div>

      <PayslipGate payslipId={id} action={revealPayslipAction} />
    </div>
  )
}
