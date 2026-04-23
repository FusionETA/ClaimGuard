import { redirect } from "next/navigation"

import { EmployeeClaimsHistory } from "@/components/claims/employee-claims-history"
import { getEmployeeClaimHistory } from "@/modules/claims/application/services/employee-portal.service"

export default async function EmployeeClaimsPage() {
  const claims = await getEmployeeClaimHistory()
  if (!claims) redirect("/login")

  return <EmployeeClaimsHistory claims={claims} />
}
