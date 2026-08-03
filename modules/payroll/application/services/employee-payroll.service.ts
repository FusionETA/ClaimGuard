import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getOrSetCache } from "@/lib/cache"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { key } from "@/lib/redis"
import type {
  PayrollRunData,
  PayslipData,
  PayslipRow,
} from "@/modules/payroll/domain/runs"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"
import {
  buildPayslipFileName,
  renderEmployeePayslipPdf,
} from "@/modules/payroll/application/services/report-renderers/bulk-payslips-pdf"

type EmployeePayslipRow = PayslipRow & {
  periodYear: number
  periodMonth: number
  submittedAt: string | null
}
/**
 * Employee-facing payslip read paths. Only returns payslips on
 * SUBMITTED runs — drafts are admin-only. The signed-in user can
 * ONLY see their own payslips (filter by their EmployeeProfile id).
 *
 * Returns null for non-employee roles or when the user has no
 * EmployeeProfile (e.g. admin-only users).
 */

export async function getEmployeePayslipsPageData(): Promise<{
  payslips: EmployeePayslipRow[]
} | null> {
  const session = await getCurrentSession()
  if (!session) return null
  // Admins use the admin payroll surfaces; supervisors + employees
  // both have their own payslips.
  if (session.role !== "EMPLOYEE" && session.role !== "SUPERVISOR") {
    return null
  }

  const orgId = resolveActiveOrgId(session)
  const employeeProfileId = await resolveEmployeeProfileId(session.userId, orgId)
  if (!employeeProfileId) return null
  // Payslips only exist for SUBMITTED runs (immutable). Cache under the
  // org payroll namespace so run submit/approve/revert busts them.
  const load = async () => ({
    payslips: await payslipRepository.listForEmployee(employeeProfileId),
  })
  if (!orgId) return load()
  return getOrSetCache(
    key("org", orgId, "payroll", "employee", session.userId, "payslips"),
    600,
    load,
  )
}

export async function getEmployeePayslipDetailPageData(input: {
  payslipId: string
}): Promise<{
  payslip: PayslipData
  run: Pick<PayrollRunData, "id" | "periodYear" | "periodMonth" | "status">
} | null> {
  const session = await getCurrentSession()
  if (!session) return null
  if (session.role !== "EMPLOYEE" && session.role !== "SUPERVISOR") {
    return null
  }

  const orgId = resolveActiveOrgId(session)
  const employeeProfileId = await resolveEmployeeProfileId(session.userId, orgId)
  if (!employeeProfileId) return null
  const load = () => loadPayslipDetail(employeeProfileId, input.payslipId)
  if (!orgId) return load()
  return getOrSetCache(
    key("org", orgId, "payroll", "employee", session.userId, "payslip", input.payslipId),
    600,
    load,
  )
}

async function loadPayslipDetail(
  employeeProfileId: string,
  payslipId: string,
): Promise<{
  payslip: PayslipData
  run: Pick<PayrollRunData, "id" | "periodYear" | "periodMonth" | "status">
} | null> {
  const payslip = await payslipRepository.getByIdForEmployee({
    payslipId,
    employeeProfileId,
  })
  if (!payslip) return null

  // Pull just the period info from the run; we don't expose the full
  // PayrollRun to employees (totals are org-wide, not their concern).
  const prisma = getPrismaClient()
  if (!prisma) return null

  const run = await prisma.payrollRun.findUnique({
    where: { id: payslip.payrollRunId },
    select: {
      id: true,
      periodYear: true,
      periodMonth: true,
      status: true,
    },
  })
  if (!run || run.status !== "SUBMITTED") return null

  return {
    payslip,
    run: { id: run.id, periodYear: run.periodYear, periodMonth: run.periodMonth, status: run.status },
  }
}

/**
 * Render this employee's individual payslip PDF on demand and return the
 * bytes for the download route to stream. Decoupled from the bulk ZIP —
 * we render just THIS payslip via the same `EmployeePayslipPdfDocument`
 * the bulk renderer uses, so nothing needs to be pre-generated or stored
 * on disk.
 *
 * Returns null when the caller isn't an employee, doesn't own this
 * payslip, or the underlying run isn't SUBMITTED.
 */
export async function getEmployeePayslipPdfBytes(input: {
  payslipId: string
}): Promise<{ bytes: Buffer; fileName: string } | null> {
  const session = await getCurrentSession()
  if (!session) return null
  if (session.role !== "EMPLOYEE" && session.role !== "SUPERVISOR") return null

  const orgId = resolveActiveOrgId(session)
  const employeeProfileId = await resolveEmployeeProfileId(session.userId, orgId)
  if (!employeeProfileId) return null

  // Ownership check — `getByIdForEmployee` scopes to this employee's
  // profile and to SUBMITTED runs, so a non-owner / draft returns null.
  const payslip = await payslipRepository.getByIdForEmployee({
    payslipId: input.payslipId,
    employeeProfileId,
  })
  if (!payslip) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const run = await prisma.payrollRun.findUnique({
    where: { id: payslip.payrollRunId },
    select: {
      id: true,
      status: true,
      periodYear: true,
      periodMonth: true,
      organization: { select: { name: true } },
    },
  })
  // Backstop the SUBMITTED gate — statutory payslips are only served for
  // finalised runs.
  if (!run || run.status !== "SUBMITTED") return null

  const bytes = await renderEmployeePayslipPdf({
    organizationName: run.organization?.name ?? "",
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    payslip,
  })

  const periodTag = `${String(run.periodMonth).padStart(2, "0")}-${run.periodYear}`
  const fileName = buildPayslipFileName({
    employeeId: payslip.snapshotEmployeeId,
    employeeName: payslip.snapshotName,
    periodTag,
  })

  return { bytes, fileName }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function resolveEmployeeProfileId(
  userId: string,
  organizationId?: string,
): Promise<string | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null
  // Multi-org: filter to the profile at the current active org so a
  // user with EmployeeProfiles at 2+ companies reads THIS company's
  // payslips, not the first-created one.
  const row = await prisma.employeeProfile.findFirst({
    where: organizationId ? { userId, organizationId } : { userId },
    select: { id: true },
  })
  return row?.id ?? null
}
