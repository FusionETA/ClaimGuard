import Link from "next/link"
import { redirect } from "next/navigation"
import { ArrowRight, CircleDollarSign, Clock3, FileCheck2, Plus } from "lucide-react"

import { ClaimCategoryIcon } from "@/components/claims/claim-category-icon"
import { ClaimStatusBadge } from "@/components/claims/claim-status-badge"
import { MetricCard } from "@/components/claims/metric-card"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getEmployeeDashboard } from "@/modules/claims/application/services/employee-portal.service"
import { categoryMeta } from "@/modules/claims/domain/metadata"
import { formatCurrency, formatShortDate } from "@/lib/utils"

export default async function EmployeeDashboardPage() {
  const data = await getEmployeeDashboard()
  if (!data) redirect("/login")

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Card className="overflow-hidden bg-gradient-to-br from-primary to-[#2a5084] text-primary-foreground">
          <CardHeader className="p-5 sm:p-8 xl:p-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-foreground/70 sm:text-xs sm:tracking-[0.18em]">
                Welcome back
              </p>
              <CardTitle className="text-2xl font-black sm:text-4xl xl:text-[2.25rem]">
                {data.employee.name}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 p-5 pt-0 sm:grid-cols-2 sm:gap-4 sm:p-8 sm:pt-0 xl:p-6 xl:pt-0">
            <div className="hidden rounded-[24px] bg-white/12 p-5 backdrop-blur-sm sm:block xl:p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-foreground/70">
                Total reimbursed
              </p>
              <p className="mt-3 text-4xl font-black tracking-tight xl:text-[2.5rem]">
                {formatCurrency(data.totals.reimbursed)}
              </p>
              <p className="mt-2 text-sm text-primary-foreground/70 xl:text-[0.95rem]">
                YTD across approved and paid claims
              </p>
            </div>
            <div className="grid gap-3 sm:gap-4 xl:content-start">
              <Button
                asChild
                className="h-11 justify-between rounded-2xl bg-white px-4 text-sm text-primary hover:bg-white/90 sm:h-12 sm:rounded-xl sm:px-6 sm:text-base xl:h-10 xl:px-5 xl:text-[0.95rem]"
              >
                <Link href="/employee/claims/new">
                  Submit new claim
                  <Plus className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                variant="secondary"
                className="h-11 justify-between rounded-2xl border-white/20 bg-white/10 px-4 text-sm text-white hover:bg-white/15 sm:h-12 sm:rounded-xl sm:px-6 sm:text-base xl:h-10 xl:px-5 xl:text-[0.95rem]"
              >
                <Link href="/employee/claims">
                  Review claim history
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="hidden gap-4 md:grid-cols-3 xl:grid xl:grid-cols-1">
          <MetricCard
            title="Awaiting review"
            value={String(data.totals.pending)}
            icon={Clock3}
            detail="Open queue"
          />
          <MetricCard
            title="Approved"
            value={String(data.totals.approved)}
            icon={FileCheck2}
            detail="Ready for payout"
          />
          <MetricCard
            title="Paid"
            value={String(data.totals.paid)}
            icon={CircleDollarSign}
            detail="Completed"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="flex-col gap-3 p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6">
            <div>
              <CardTitle className="text-xl sm:text-lg">Recent claims</CardTitle>
            </div>
            <Button asChild variant="ghost" className="h-9 w-full rounded-2xl text-sm sm:w-auto sm:rounded-lg">
              <Link href="/employee/claims">View all</Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3 p-5 pt-0 sm:p-6 sm:pt-0">
            {data.recentClaims.slice(0, 4).map((claim) => (
              <div
                key={claim.id}
                className="flex flex-col gap-3 rounded-[20px] bg-surface-low p-3.5 sm:gap-4 sm:rounded-[24px] sm:p-4 md:flex-row md:items-center md:justify-between"
              >
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="rounded-xl bg-white p-2.5 text-primary shadow-sm sm:rounded-2xl sm:p-3">
                    <ClaimCategoryIcon category={claim.category} className="h-4 w-4 sm:h-5 sm:w-5" />
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">
                      {claim.claimNumber}
                    </p>
                    <p className="mt-1 text-base font-black sm:text-lg">{claim.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
                      {formatShortDate(claim.submittedAt)} · {categoryMeta[claim.category].label}
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3 md:flex-col md:items-end">
                  <p className="text-base font-black sm:text-lg">{formatCurrency(claim.amount)}</p>
                  <ClaimStatusBadge status={claim.status} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="hidden lg:block">
          <CardHeader>
            <CardTitle>Profile snapshot</CardTitle>
            <CardDescription>Current employee profile used for claim routing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-[24px] bg-surface-low p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Employee ID</p>
              <p className="mt-2 text-xl font-black">{data.employee.employeeId}</p>
            </div>
            <div className="rounded-[24px] bg-surface-low p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Project</p>
              <p className="mt-2 text-xl font-black">{data.employee.project}</p>
            </div>
            <div className="rounded-[24px] bg-surface-low p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Role</p>
              <p className="mt-2 text-xl font-black">{data.employee.jobTitle}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
