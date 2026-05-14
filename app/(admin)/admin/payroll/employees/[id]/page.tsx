import Link from "next/link"
import { redirect } from "next/navigation"
import { ChevronLeft } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PayrollEmployeeDetail } from "@/components/admin/payroll-employee-detail"
import { getPayrollEmployeeDetailPageData } from "@/modules/payroll/application/services/payroll-profile.service"
import { isPayrollProfileComplete } from "@/modules/payroll/domain/models"

/**
 * /admin/payroll/employees/[id]
 *
 * Server-component page wrapper. Fetches the employee + their
 * PayrollProfile (or null if not yet onboarded), then hands off to the
 * client-side <PayrollEmployeeDetail/> for the tabbed form.
 */
export default async function AdminPayrollEmployeeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await getPayrollEmployeeDetailPageData({ userId: id })
  if (!data) {
    // Either not signed in as admin, no org, or employee not in this org.
    redirect("/admin/payroll/employees")
  }

  const complete = data.profile ? isPayrollProfileComplete(data.profile) : false

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/payroll/employees">
              <ChevronLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
          <div className="space-y-0.5">
            <h1 className="text-xl font-semibold text-foreground">
              {data.name}
              <span className="ml-2 text-sm text-muted-foreground">
                {data.employeeId}
              </span>
            </h1>
            <p className="text-xs text-muted-foreground">
              {data.jobTitle} · {data.email}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data.profile?.isArchived ? (
            <Badge variant="outline">Archived</Badge>
          ) : complete ? (
            <Badge
              variant="outline"
              className="border-emerald-300/60 text-emerald-700"
            >
              Ready for payroll
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="border-amber-300/60 text-amber-700"
            >
              Needs setup
            </Badge>
          )}
        </div>
      </div>

      <PayrollEmployeeDetail
        userId={data.userId}
        identity={{
          name: data.name,
          employeeId: data.employeeId,
          email: data.email,
          jobTitle: data.jobTitle,
        }}
        profile={data.profile}
        defaultEpfEmployerRate={data.defaultEpfEmployerRate}
        salaryHistory={data.salaryHistory}
      />
    </div>
  )
}
