import { redirect } from "next/navigation"

import { ClaimForm } from "@/app/(employee)/employee/claims/new/claim-form"
import { getEmployeeClaimSubmissionData } from "@/modules/claims/application/services/employee-portal.service"

export default async function NewClaimPage() {
  const data = await getEmployeeClaimSubmissionData()
  if (!data) redirect("/login")

  return (
    <ClaimForm
      chartAccounts={data.chartAccounts}
      claimRunPreview={data.claimRunPreview}
      organizationName={data.organization?.name}
    />
  )
}
