import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import type { PayslipRow } from "@/modules/payroll/domain/runs"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"

/**
 * GET /api/v1/payroll-runs/[id]
 *
 * Required scope: `payroll:read`.
 *
 * Returns a single payroll run with its per-employee payslip rows.
 * Used by external systems to verify the run's contents before
 * calling the approval endpoint.
 *
 * 404 when the run id doesn't exist OR belongs to a different org
 * (defence-in-depth — we never leak cross-tenant data).
 *
 * The response wraps:
 *   - `run`: same shape the list endpoint returns
 *   - `payslips`: array of frozen per-employee snapshots from this run
 */
export const GET = handleApiRequest<{ id: string }>(
  ["payroll:read"],
  async (_request, ctx) => {
    const { id } = ctx.params

    const run = await payrollRunRepository.getByIdForOrg({
      id,
      organizationId: ctx.integration.organizationId,
    })
    if (!run) {
      return NextResponse.json(
        { error: { status: 404, message: "Payroll run not found." } },
        { status: 404 },
      )
    }

    const payslips = await payslipRepository.listForRun(run.id)

    return NextResponse.json({
      data: {
        run: {
          id: run.id,
          organizationId: run.organizationId,
          periodYear: run.periodYear,
          periodMonth: run.periodMonth,
          status: run.status,
          totals: {
            gross: run.totalGross,
            net: run.totalNet,
            pcb: run.totalPcb,
            zakat: run.totalZakat,
            hrdf: run.totalHrdf,
            employeeEpf: run.totalEmployeeEpf,
            employerEpf: run.totalEmployerEpf,
            employeeSocso: run.totalEmployeeSocso,
            employerSocso: run.totalEmployerSocso,
            employeeEis: run.totalEmployeeEis,
            employerEis: run.totalEmployerEis,
            costToEmployer: run.totalCostToEmployer,
            employeeCount: run.employeeCount,
            payslipCount: run.payslipCount,
          },
          submittedForApprovalAt: run.submittedForApprovalAt,
          submittedForApprovalById: run.submittedForApprovalById,
          submittedAt: run.submittedAt,
          submittedById: run.submittedById,
          approvalRejectionReason: run.approvalRejectionReason,
          xeroSync: {
            status: run.xeroSyncStatus,
            manualJournalId: run.xeroManualJournalId,
            journalNumber: run.xeroJournalNumber,
            syncedAt: run.xeroSyncedAt,
          },
          createdAt: run.createdAt,
        },
        payslips: payslips.map(toExternalPayslip),
      },
    })
  },
)

/**
 * Compact per-employee payslip projection. We drop the full
 * `lineItems` array (~10 line items per employee can balloon the
 * payload to many KB) — the external use case here is just verifying
 * totals before approval, so the aggregates are what matters. Line
 * items can be added later if a consumer needs the breakdown.
 */
function toExternalPayslip(p: PayslipRow) {
  return {
    id: p.id,
    employeeProfileId: p.employeeProfileId,
    employee: {
      name: p.snapshotName,
      employeeId: p.snapshotEmployeeId,
      position: p.snapshotPosition,
      salaryType: p.snapshotSalaryType,
      nationality: p.snapshotNationality,
      isResident: p.snapshotIsResident,
    },
    pay: {
      basic: p.basicPay,
      prorated: p.proratedPay,
      proratedFactor: p.proratedFactor,
      proratedDays: p.proratedDays,
      totalWorkingDays: p.totalWorkingDays,
      otPay: p.otPay,
      totalAllowances: p.totalAllowances,
      totalBenefitsInKind: p.totalBenefitsInKind,
      totalReimbursements: p.totalReimbursements,
      totalDeductions: p.totalDeductions,
      gross: p.grossPay,
      net: p.netPay,
      costToEmployer: p.totalCostToEmployer,
    },
    statutory: {
      epfEmployee: p.epfEmployee,
      epfEmployer: p.epfEmployer,
      socsoEmployee: p.socsoEmployee,
      socsoEmployer: p.socsoEmployer,
      eisEmployee: p.eisEmployee,
      eisEmployer: p.eisEmployer,
      pcb: p.pcb,
      hrdf: p.hrdf,
      zakat: p.zakat,
    },
    lineItemCount: p.lineItemCount,
  }
}
