import { redirect } from "next/navigation"

import { Cp8dConverterModal } from "@/components/admin/cp8d-converter-modal"
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

      {/* CP8D converter — sits below the annual downloads card. Manual
          row-by-row entry → ZIP of the M (employer master) and P
          (employee particulars) TXT files for LHDN's e-CP8D portal.
          Useful for mid-year cutovers, one-off corrections, or testing
          the upload without needing a full Jan-Dec payroll cycle. */}
      <section className="rounded-xl border border-dashed border-border/60 bg-card/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold text-foreground">
              CP8D converter
            </h2>
            <p className="text-xs text-muted-foreground">
              Hand-enter CP8D (annual per-employee particulars) rows and
              download the M+P TXT pair as a ZIP — no payroll run required.
            </p>
          </div>
          <Cp8dConverterModal
            defaultEmployerName={data.organizationName}
            defaultYear={data.selectedYear ?? undefined}
          />
        </div>
      </section>
    </div>
  )
}
