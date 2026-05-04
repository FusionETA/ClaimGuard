import { redirect } from "next/navigation"

import { ComingSoonCard } from "@/components/ui/coming-soon-card"
import { getCurrentSession } from "@/lib/auth/session"

export default async function AdminLeavePage() {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") redirect("/login")

  return (
    <ComingSoonCard
      title="Leave"
      body="Leave applications and balances will live here. Coming as a separate module."
    />
  )
}
