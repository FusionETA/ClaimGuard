import { redirect } from "next/navigation"

import { Cp38ConverterModal } from "@/components/admin/cp38-converter-modal"
import { PayrollAnnualDownloadsCard } from "@/components/admin/payroll-annual-downloads-card"
import { requireAdminModule } from "@/modules/organization/application/services/admin-access.service"
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
  await requireAdminModule("payroll")
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
          Year-end statutory forms generated only after every Jan-Dec
          payroll run is approved. Forms EA must be issued to employees
          by 28 Feb; Form E + CP8D filed with LHDN by 31 Mar (or 30 Apr
          e-Filed).
        </p>
      </header>

      <PayrollAnnualDownloadsCard
        organizationName={data.organizationName}
        availableYears={data.availableYears}
        selectedYear={data.selectedYear}
        rows={data.rows}
        canGenerate={data.canGenerate}
        submittedMonthCount={data.submittedMonthCount}
        missingMonths={data.missingMonths}
        employerNoConfigured={data.employerNoConfigured}
      />

      {/* CP38 converter — sits below the annual downloads card. Manual
          row-by-row entry → fixed-width TXT for LHDN's e-CP39 portal.
          Useful for one-off court-order CP38 filings or for testing the
          upload workflow without needing a full Jan-Dec payroll cycle. */}
      <section className="rounded-xl border border-dashed border-border/60 bg-card/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold text-foreground">
              CP38 converter
            </h2>
            <p className="text-xs text-muted-foreground">
              Hand-enter CP38 (court-order tax) rows and download a
              LHDN-formatted TXT — no payroll run required.
            </p>
          </div>
          <Cp38ConverterModal
            defaultYear={data.selectedYear}
            defaultMonth={new Date().getMonth() + 1}
          />
        </div>
      </section>
    </div>
  )
}
