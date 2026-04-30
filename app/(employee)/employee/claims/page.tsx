import Link from "next/link"
import { redirect } from "next/navigation"
import { Plus } from "lucide-react"

import { EmployeeClaimsHistory } from "@/components/claims/employee-claims-history"
import { getEmployeeClaimHistory } from "@/modules/claims/application/services/employee-portal.service"

export default async function EmployeeClaimsPage() {
  const claims = await getEmployeeClaimHistory()
  if (!claims) redirect("/login")

  return (
    <>
      <EmployeeClaimsHistory claims={claims} />
      <Link
        href="/employee/claims/new"
        aria-label="New claim"
        className="fixed bottom-24 left-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-panel transition-transform hover:scale-105 lg:bottom-8 lg:left-8"
      >
        <Plus className="h-6 w-6" />
      </Link>
    </>
  )
}
