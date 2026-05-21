import { redirect } from "next/navigation"

import { PayrollAnnualDownloadsCard } from "@/components/admin/payroll-annual-downloads-card"
import { getPayrollAnnualReportsPageData } from "@/modules/payroll/application/services/payroll-annual-reports.service"

/**
 * /admin/payroll/annual-forms
 *
 * Year-level tax forms — Form EA Bulk, Form E + CP8D, and the two
 * CP8D TXT files for LHDN's e-CP8D upload. Selecting a year reloads
 * the page with `?year=YYYY`; the modal-style card lists every
 * cached file with a Download button per row.
 */
export default async function AdminAnnualPayrollFormsPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>
}) {
  const params = await searchParams
  const yearParam = params.year ? Number(params.year) : null
  const year =
    yearParam && Number.isInteger(yearParam) && yearParam > 1900
      ? yearParam
      : null

  const data = await getPayrollAnnualReportsPageData({ year })
  if (!data) redirect("/login")

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-foreground">
          Annual Tax Forms
        </h1>
        <p className="text-sm text-muted-foreground">
          Year-end statutory forms aggregated across every SUBMITTED
          payroll run. Forms EA must be issued to employees by 28 Feb;
          Form E + CP8D filed with LHDN by 31 Mar (or 30 Apr e-Filed).
        </p>
      </header>

      <PayrollAnnualDownloadsCard
        organizationName={data.organizationName}
        availableYears={data.availableYears}
        selectedYear={data.selectedYear}
        rows={data.rows}
        canGenerate={data.canGenerate}
        employerNoConfigured={data.employerNoConfigured}
      />
    </div>
  )
}
