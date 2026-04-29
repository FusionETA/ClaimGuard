import { Construction } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { requirePortalSession } from "@/lib/auth/session"

export default async function EmployeePayslipPage() {
  await requirePortalSession("EMPLOYEE")

  return (
    <Card className="mx-auto max-w-2xl">
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <Construction className="h-6 w-6" />
        </div>
        <h2 className="font-headline text-xl font-bold text-foreground">Payslip</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Monthly payslips will appear here once payroll integration ships.
        </p>
      </CardContent>
    </Card>
  )
}
