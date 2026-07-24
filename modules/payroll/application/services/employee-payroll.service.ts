import "server-only"

import { readFile } from "node:fs/promises"
import path from "node:path"

import JSZip from "jszip"

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
import { payrollRunReportRepository } from "@/modules/payroll/infrastructure/payroll-run-report.repository"
import {
  buildPayslipFileName,
  sanitise,
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
 * Extracts this employee's individual payslip PDF from the pre-generated
 * bulk payslips ZIP. Returns null when the ZIP hasn't been generated yet
 * (background pre-gen still in progress or run not yet approved).
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

  const payslip = await payslipRepository.getByIdForEmployee({
    payslipId: input.payslipId,
    employeeProfileId,
  })
  if (!payslip) return null

  const prisma = getPrismaClient()
  if (!prisma) return null

  const [run, report] = await Promise.all([
    prisma.payrollRun.findUnique({
      where: { id: payslip.payrollRunId },
      select: { id: true, status: true, periodYear: true, periodMonth: true },
    }),
    payrollRunReportRepository.getByRunAndKind({
      payrollRunId: payslip.payrollRunId,
      kind: "BULK_PAYSLIPS_PDF",
    }),
  ])
  if (!run || run.status !== "SUBMITTED") return null
  if (!report) return null

  const zipPath = path.join(process.cwd(), "public", report.fileUrl.replace(/^\/+/, ""))
  let zipBytes: Buffer
  try {
    zipBytes = await readFile(zipPath)
  } catch {
    return null
  }

  const zip = await JSZip.loadAsync(zipBytes)
  const periodTag = `${String(run.periodMonth).padStart(2, "0")}-${run.periodYear}`

  // Try the canonical name first, then fall back to a prefix match (handles
  // the rare dedupe-suffix case where two employees share a name).
  const expectedName = buildPayslipFileName({
    employeeId: payslip.snapshotEmployeeId,
    employeeName: payslip.snapshotName,
    periodTag,
  })
  const idPrefix = sanitise(payslip.snapshotEmployeeId) + "_"

  const entry =
    zip.file(expectedName) ??
    Object.values(zip.files).find(
      (f) => !f.dir && f.name.startsWith(idPrefix) && f.name.endsWith(".pdf"),
    ) ??
    null

  if (!entry) return null

  const pdfBytes = Buffer.from(await entry.async("arraybuffer"))
  return { bytes: pdfBytes, fileName: expectedName }
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
