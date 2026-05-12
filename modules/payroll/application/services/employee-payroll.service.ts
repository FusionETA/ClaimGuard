import "server-only"

import { getCurrentSession } from "@/lib/auth/session"
import { getPrismaClient } from "@/lib/prisma"
import type {
  PayrollRunData,
  PayslipData,
  PayslipRow,
} from "@/modules/payroll/domain/runs"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"

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

  const employeeProfileId = await resolveEmployeeProfileId(session.userId)
  if (!employeeProfileId) return null

  const payslips = await payslipRepository.listForEmployee(employeeProfileId)
  return { payslips }
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

  const employeeProfileId = await resolveEmployeeProfileId(session.userId)
  if (!employeeProfileId) return null

  const payslip = await payslipRepository.getByIdForEmployee({
    payslipId: input.payslipId,
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

// ─── Helpers ─────────────────────────────────────────────────────────────

async function resolveEmployeeProfileId(userId: string): Promise<string | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null
  const row = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: { id: true },
  })
  return row?.id ?? null
}
