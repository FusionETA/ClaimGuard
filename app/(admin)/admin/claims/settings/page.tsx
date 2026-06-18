import { AdminSettingsPanelPage } from "@/app/(admin)/admin/settings/settings-panel-page"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"

export default async function AdminClaimsSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdminModule(["claims_personal", "claims_company"])
  return (
    <AdminSettingsPanelPage
      searchParams={(await searchParams) ?? {}}
      initialTab="claims"
      visibleTabs={["claims"]}
    />
  )
}
