import { redirect } from "next/navigation"

import { ClaimsPageClient } from "@/app/(employee)/employee/claims/claims-page-client"
import { ClaimsSubNav } from "@/components/claims/claims-sub-nav"
import { getCurrentSession } from "@/lib/auth/session"
import {
  getEmployeeClaimHistory,
  getEmployeeClaimSubmissionData,
} from "@/modules/claims/application/services/employee-portal.service"
import { requireModuleAccess } from "@/modules/policy/application/guards"

export default async function EmployeeClaimsPage() {
  await requireModuleAccess("claims")
  const [session, claims, submissionData] = await Promise.all([
    getCurrentSession(),
    getEmployeeClaimHistory(),
    getEmployeeClaimSubmissionData(),
  ])

  if (!session || !claims || !submissionData) redirect("/login")

  return (
    <>
      <ClaimsSubNav role={session.role} />
      <ClaimsPageClient
        claims={claims}
        chartAccounts={submissionData.chartAccounts}
        mileageAccounts={submissionData.mileageAccounts}
        bankAccounts={submissionData.bankAccounts}
        defaultMileageRate={submissionData.organization?.defaultMileageRate}
        mileageUnit={submissionData.organization?.mileageUnit ?? "KM"}
        claimRunPreview={submissionData.claimRunPreview}
        organizationName={submissionData.organization?.name}
        employeeProjects={submissionData.employeeProjects}
        allowedCurrencies={submissionData.organization?.allowedCurrencies}
        defaultCurrency={submissionData.organization?.defaultCurrency}
      />
    </>
  )
}
