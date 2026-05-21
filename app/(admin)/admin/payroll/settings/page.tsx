import { redirect } from "next/navigation"

import { PayrollSettingsForm } from "@/components/admin/payroll-settings-form"
import { getPayrollSettingsPageData } from "@/modules/payroll/application/services/payroll-settings.service"

/**
 * /admin/payroll/settings
 *
 * Server-component wrapper. Loads PayrollSettings + PayrollCompanyInfo
 * for the active org in one shot, then hands off to the tabbed client
 * form. Each tab saves to its own table via its own server action.
 */
export default async function AdminPayrollSettingsPage() {
  const data = await getPayrollSettingsPageData()
  if (!data) redirect("/login")

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h1 className="text-xl font-semibold text-foreground">
            Payroll Settings
          </h1>
          <p className="text-xs text-muted-foreground">
            {data.organizationName} · Operational rules + Form E employer
            particulars
          </p>
        </div>
      </div>

      <PayrollSettingsForm
        settings={data.settings}
        companyInfo={data.companyInfo}
        malaysianEmployeeCount={data.malaysianEmployeeCount}
        hrdfTier={data.hrdfTier}
        hasXeroConnection={data.hasXeroConnection}
      />
    </div>
  )
}
