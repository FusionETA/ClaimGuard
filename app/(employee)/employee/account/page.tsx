import { redirect } from "next/navigation"
import { Bell, Landmark, ShieldCheck } from "lucide-react"

import { MetricCard } from "@/components/claims/metric-card"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getEmployeeAccount } from "@/modules/claims/application/services/employee-portal.service"

export default async function EmployeeAccountPage() {
  const data = await getEmployeeAccount()
  if (!data) redirect("/login")

  return (
    <div className="grid gap-4 sm:gap-6 xl:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader className="p-5 sm:p-6">
          <CardTitle className="text-xl sm:text-lg">{data.employee.name}</CardTitle>
          <CardDescription className="text-sm leading-6">
            Profile details used for approvals, routing, payouts, and team visibility.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 p-5 pt-0 sm:gap-4 sm:p-6 sm:pt-0 md:grid-cols-2">
          <div className="rounded-[20px] bg-surface-low p-4 sm:rounded-[24px] sm:p-5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">Name</p>
            <p className="mt-2 text-lg font-black sm:text-xl">{data.employee.name}</p>
          </div>
          <div className="rounded-[20px] bg-surface-low p-4 sm:rounded-[24px] sm:p-5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">Email</p>
            <p className="mt-2 text-lg font-black sm:text-xl">{data.employee.email}</p>
          </div>
          <div className="rounded-[20px] bg-surface-low p-4 sm:rounded-[24px] sm:p-5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">Employee ID</p>
            <p className="mt-2 text-lg font-black sm:text-xl">{data.employee.employeeId}</p>
          </div>
          <div className="rounded-[20px] bg-surface-low p-4 sm:rounded-[24px] sm:p-5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">Job title</p>
            <p className="mt-2 text-lg font-black sm:text-xl">{data.employee.jobTitle}</p>
          </div>
          <div className="rounded-[20px] bg-surface-low p-4 sm:rounded-[24px] sm:p-5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">Reports to</p>
            <p className="mt-2 text-lg font-black sm:text-xl">
              {data.employee.supervisorName ?? "No supervisor assigned"}
            </p>
            {data.employee.supervisorEmail ? (
              <p className="mt-1 text-sm text-muted-foreground">{data.employee.supervisorEmail}</p>
            ) : null}
          </div>
          <div className="rounded-[20px] bg-surface-low p-4 sm:rounded-[24px] sm:p-5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">Preferred currency</p>
            <p className="mt-2 text-lg font-black sm:text-xl">{data.employee.preferredCurrency}</p>
          </div>
          <div className="rounded-[20px] bg-surface-low p-4 sm:rounded-[24px] sm:p-5 md:col-span-2">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">Projects</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="inline-flex rounded-full bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground">
                {data.employee.project}
              </span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Multi-project assignment is not enabled yet, so your current primary project is shown here.
            </p>
          </div>
          <div className="rounded-[20px] bg-surface-low p-4 sm:rounded-[24px] sm:p-5 md:col-span-2">
            <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:text-xs sm:tracking-[0.18em]">Payout method</p>
            <p className="mt-2 text-lg font-black sm:text-xl">{data.employee.payoutMethod}</p>
          </div>
        </CardContent>
      </Card>

      <div className="hidden gap-4 xl:grid">
        <MetricCard title="Notifications" value={data.preferences.notifications ? "On" : "Off"} icon={Bell} detail="Email + in-app" />
        <MetricCard title="Banking" value="Verified" icon={Landmark} detail="Payout route" />
        <MetricCard title="Policy version" value={data.preferences.expensePolicyVersion} icon={ShieldCheck} detail="Compliance" />
      </div>
    </div>
  )
}
