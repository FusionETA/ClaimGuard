import { redirect } from "next/navigation"

import { ClaimsPageClient } from "@/app/(employee)/employee/claims/claims-page-client"
import {
  getEmployeeClaimHistory,
  getEmployeeClaimSubmissionData,
} from "@/modules/claims/application/services/employee-portal.service"

export default async function EmployeeClaimsPage() {
  const [claims, submissionData] = await Promise.all([
    getEmployeeClaimHistory(),
    getEmployeeClaimSubmissionData(),
  ])

  if (!claims || !submissionData) redirect("/login")

  return (
    <ClaimsPageClient
      claims={claims}
      chartAccounts={submissionData.chartAccounts}
      mileageAccounts={submissionData.mileageAccounts}
      bankAccounts={submissionData.bankAccounts}
      defaultMileageRate={submissionData.organization?.defaultMileageRate}
      mileageUnit={submissionData.organization?.mileageUnit ?? "KM"}
      claimRunPreview={submissionData.claimRunPreview}
      organizationName={submissionData.organization?.name}
    />
  )
}
