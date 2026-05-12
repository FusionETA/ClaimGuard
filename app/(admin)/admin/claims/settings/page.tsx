import { AdminSettingsPanelPage } from "@/app/(admin)/admin/settings/settings-panel-page"

export default async function AdminClaimsSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <AdminSettingsPanelPage
      searchParams={(await searchParams) ?? {}}
      initialTab="claims"
      visibleTabs={["claims"]}
    />
  )
}
