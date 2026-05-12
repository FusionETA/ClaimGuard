import { ComingSoonCard } from "@/components/ui/coming-soon-card"
import { requirePortalSession } from "@/lib/auth/session"
import { requireModuleAccess } from "@/modules/policy/application/guards"

export default async function EmployeeLeavePage() {
  await requirePortalSession("EMPLOYEE")
  await requireModuleAccess("leave")

  return (
    <ComingSoonCard
      title="Leave"
      body="Leave applications and balances will live here. Coming as a separate module."
    />
  )
}
