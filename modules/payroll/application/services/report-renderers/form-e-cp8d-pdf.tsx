import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { FormECp8dPdfDocument } from "@/components/admin/payroll-annual-pdf-documents"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { loadAnnualPayrollPayload } from "@/modules/payroll/application/services/report-renderers/annual-shared"

export async function renderFormECp8dPdf(input: {
  year: number
}): Promise<Buffer> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const payload = await loadAnnualPayrollPayload({
    organizationId: orgId,
    year: input.year,
  })
  if (!payload) throw new Error("Could not load annual payroll data.")
  if (payload.employees.length === 0) {
    throw new Error(
      `No SUBMITTED payroll runs found for ${input.year}. Submit + approve at least one run before generating Form E.`,
    )
  }

  // Part A counts — derived from live data:
  //  - A1: live, non-archived headcount as at year end. We approximate
  //    with "active non-archived employees with a complete PayrollProfile"
  //    since the snapshot view of "as at 31 Dec" requires historical
  //    state we don't store.
  //  - A2: employees with PCB > 0 across the year.
  //  - A3: new employees — those whose joinDate falls in the year.
  const prisma = getPrismaClient()
  let headcountAtYearEnd = payload.employees.length
  let newEmployees = 0
  if (prisma) {
    const yearStart = new Date(input.year, 0, 1)
    const yearEnd = new Date(input.year, 11, 31, 23, 59, 59)
    const newHires = await prisma.payrollProfile.count({
      where: {
        employeeProfile: {
          user: { organizationId: orgId },
        },
        joinDate: { gte: yearStart, lte: yearEnd },
        isArchived: false,
      },
    })
    newEmployees = newHires
    const active = await prisma.payrollProfile.count({
      where: {
        employeeProfile: {
          user: { organizationId: orgId },
        },
        isArchived: false,
      },
    })
    headcountAtYearEnd = active || payload.employees.length
  }
  const headcountSubjectToMtd = payload.employees.filter(
    (e) => e.totalPcb > 0,
  ).length

  return renderToBuffer(
    <FormECp8dPdfDocument
      payload={payload}
      partA={{
        headcountAtYearEnd,
        headcountSubjectToMtd,
        newEmployees,
      }}
      generatedAt={new Date()}
    />,
  )
}
