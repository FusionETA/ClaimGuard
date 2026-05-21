import { redirect } from "next/navigation"
import { HandCoins } from "lucide-react"

import { LoansManager } from "@/components/admin/loans-manager"
import { getLoansPageData } from "@/modules/payroll/application/services/loan.service"

/**
 * /admin/payroll/loans
 *
 * Admin-only staff-loan / cash-advance manager. A loan repays via an
 * automatic monthly deduction on each payroll run inside the repayment
 * window — the installment lands on the payslip under the "Advance
 * Deduction" category (`deduct_advance`) and reduces take-home pay.
 */
export default async function AdminPayrollLoansPage() {
  const data = await getLoansPageData()
  if (!data) redirect("/login")

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
          <HandCoins className="h-6 w-6 text-primary" />
          Loans &amp; advances
        </h1>
        <p className="text-sm text-muted-foreground">
          Record a staff loan or cash advance and set its repayment
          timeline. The monthly installment is deducted automatically on
          every payroll run until the loan is repaid.
        </p>
      </header>

      <LoansManager loans={data.loans} employees={data.employees} />
    </div>
  )
}
