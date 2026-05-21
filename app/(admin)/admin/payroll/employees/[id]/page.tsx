import Link from "next/link"
import type { Route } from "next"
import { redirect } from "next/navigation"
import { ChevronLeft } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PayrollEmployeeDetail } from "@/components/admin/payroll-employee-detail"
import type { EmployeeCompanyData } from "@/components/admin/employee-company-form"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getAdminHierarchyPageData } from "@/modules/claims/application/services/admin-page-data.service"
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
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const data = await getPayrollEmployeeDetailPageData({ userId: id })
  if (!data) {
    // Either not signed in as admin, no org, or employee not in this org.
    redirect("/admin/hierarchy")
  }

  // Org-hierarchy context for the "Company" tab. Resolve the matching
  // member (OrganizationMember.id === User.id) plus the option lists the
  // editor needs. Null when it can't be resolved — the tab is hidden.
  const session = await getCurrentSession()
  const organizationId = session ? resolveActiveOrgId(session) : undefined
  const hierarchy = await getAdminHierarchyPageData({ organizationId })
  let company: EmployeeCompanyData | null = null
  const member = hierarchy?.members.find((m) => m.id === data.userId)
  if (hierarchy && member) {
    const xeroConnection = hierarchy.xeroConnections[0]
    company = {
      member,
      projects: hierarchy.projects,
      xeroConnection,
      teams: hierarchy.teams,
      allMembers: hierarchy.members,
      policies: hierarchy.policies,
    }
  }

  // Optional ?from=<absolute internal path> lets the linking page tell
  // us where the user came from so the Back button can return there.
  // We validate the value carefully: only same-origin absolute paths
  // under /admin/ are accepted, to avoid open-redirect risk. Bad or
  // missing values fall through to the employees list.
  const sp = (await searchParams) ?? {}
  const fromRaw = typeof sp.from === "string" ? sp.from : null
  const safeFrom =
    fromRaw && /^\/admin\/[A-Za-z0-9_\-/?=&%.]*$/.test(fromRaw)
      ? fromRaw
      : null
  const backHref = (safeFrom ?? "/admin/hierarchy") as Route
  const backLabel = safeFrom?.includes("/payroll/runs/")
    ? "Back to payroll run"
    : "Back"

  const complete = data.profile ? isPayrollProfileComplete(data.profile) : false

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link href={backHref}>
              <ChevronLeft className="h-4 w-4" />
              {backLabel}
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
        company={company}
      />
    </div>
  )
}
