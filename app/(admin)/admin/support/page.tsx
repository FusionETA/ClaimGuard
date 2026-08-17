import { redirect } from "next/navigation"

import { BackButton } from "@/components/ui/back-button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getCurrentSession, getHomePathForRole } from "@/lib/auth/session"
import { getSupportPickerPageData } from "@/modules/organization/application/services/superadmin-support.service"

import { SupportPicker } from "./support-picker"
import { CreateCompanyCard } from "./create-company-card"

export const metadata = {
  title: "Support mode · AltomateHR",
}

/**
 * Superadmin-only picker page. Lists every organisation on the
 * platform so a Fusioneta-side support user can jump into any of
 * them to help debug / fix.
 *
 * Gate: `session.isSuperadmin`. Anyone else bounces back to their
 * own home portal — the URL is not a secret but seeing it does
 * nothing without the env-whitelisted email.
 */
export default async function SupportPage() {
  const session = await getCurrentSession()
  if (!session) redirect("/login")
  if (!session.isSuperadmin) redirect(getHomePathForRole(session.role))

  const { orgs } = await getSupportPickerPageData()

  return (
    <div className="space-y-6">
      <BackButton href="/admin" />
      <Card>
        <CardHeader>
          <CardTitle>Support mode</CardTitle>
          <CardDescription>
            Pick an organisation to enter as admin. The customer&apos;s
            admins won&apos;t see your name in their activity log —
            actions land as &quot;System (Support)&quot; on their side.
            Every action you take is recorded on the Fusioneta-side
            SuperadminAuditLog with your real email for internal
            accountability.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SupportPicker orgs={orgs} />
        </CardContent>
      </Card>

      <CreateCompanyCard />
    </div>
  )
}
