import { AdminSettingsPanelPage } from "@/app/(admin)/admin/settings/settings-panel-page"

export default async function AdminLeaveSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  return (
    <AdminSettingsPanelPage
      searchParams={(await searchParams) ?? {}}
      initialTab="leave"
      visibleTabs={["leave"]}
    />
  )
}
