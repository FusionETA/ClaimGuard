import { redirect } from "next/navigation"

import { AdminSettingsPanelPage } from "@/app/(admin)/admin/settings/settings-panel-page"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"

const CLAIMS_SETTINGS_TABS = new Set(["claims", "runs", "currencies"])

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = (await searchParams) ?? {}
  const tab = typeof params.tab === "string" ? params.tab : undefined

  if (tab && CLAIMS_SETTINGS_TABS.has(tab)) {
    redirect("/admin/claims/settings")
  }

  if (tab === "leave") {
    redirect("/admin/leave/settings")
  }

  await requireAdminModule("settings")

  return (
    <AdminSettingsPanelPage
      searchParams={params}
      visibleTabs={["organization", "accounts", "projects", "work-schedule", "policies"]}
    />
  )
}
