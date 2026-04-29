import { SupervisorShell } from "@/components/layout/supervisor-shell"
import { requirePortalSession } from "@/lib/auth/session"

export default async function SupervisorLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await requirePortalSession("SUPERVISOR")

  return (
    <SupervisorShell user={session} organizationName={session.organizationName}>
      {children}
    </SupervisorShell>
  )
}
