import Link from "next/link"
import type { Route } from "next"
import { redirect } from "next/navigation"
import { ChevronRight, Lock } from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getEmployeePayslipsPageData } from "@/modules/payroll/application/services/employee-payroll.service"
import { periodLabel } from "@/modules/payroll/domain/runs"

/**
 * /employee/payslips — employee-facing list of their payslips. Only
 * shows payslips on SUBMITTED runs (drafts are admin-only). Sorted
 * newest-first by period.
 */
export default async function EmployeePayslipsPage() {
  const data = await getEmployeePayslipsPageData()
  if (!data) redirect("/login")

  return (
    <div className="space-y-6">
      {data.payslips.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No payslips yet</CardTitle>
            <CardDescription>
              You&apos;ll see them here once payroll finalises your
              first monthly run.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-1.5 p-4">
            {data.payslips.map((p) => (
              <Link
                key={p.id}
                href={`/employee/payslips/${p.id}` as Route}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-transparent px-3 py-2 text-sm transition hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-foreground">
                    {periodLabel(p.periodYear, p.periodMonth)}
                  </span>
                  {/* Amounts are deliberately NOT shown here — the figures
                      only appear after the password unlock on the detail
                      page. Keep this line to the issue date only. */}
                  <span className="truncate text-xs text-muted-foreground">
                    {p.submittedAt
                      ? `Issued ${new Date(p.submittedAt).toLocaleDateString()}`
                      : "Monthly payslip"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">View</span>
                  <ChevronRight className="h-4 w-4" />
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
