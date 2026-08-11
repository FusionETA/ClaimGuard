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
    // SKBBK has no stored run-total column (unlike PCB / EPF / SOCSO /
    // …), so derive the run-level figure by summing the frozen payslips.
    // Round to 2dp to avoid float drift when adding many Decimal(12,2)s.
    const totalSkbbk =
      Math.round(
        payslips.reduce((sum, p) => sum + p.skbbkEmployee, 0) * 100,
      ) / 100

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
            skbbk: totalSkbbk,
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
 * Per-employee payslip projection. Returns the FULL breakdown so
 * external consumers can reconstruct the payslip exactly: every line
 * item with its category + amount + statutory flags, the frozen
 * snapshot rates, the OT hour split, and audit timestamps.
 *
 * Trade-off: a 100-employee run with ~20 line items each lands at
 * ~240 KB of JSON. Still fine for a single GET. If we ever need to
 * shrink it we can add a `?slim=true` query param to fall back to
 * aggregates only.
 */
function toExternalPayslip(p: PayslipRow) {
  return {
    id: p.id,
    employeeProfileId: p.employeeProfileId,
    payrollProfileId: p.payrollProfileId,
    employee: {
      name: p.snapshotName,
      employeeId: p.snapshotEmployeeId,
      position: p.snapshotPosition,
      salaryType: p.snapshotSalaryType,
      monthlySalary: p.snapshotMonthlySalary,
      hourlyRate: p.snapshotHourlyRate,
      nationality: p.snapshotNationality,
      isResident: p.snapshotIsResident,
    },
    /// Attendance / hours context used in the calc.
    attendance: {
      workedHours: p.workedHours,
      expectedHours: p.expectedHours,
      unpaidLeaveDays: p.unpaidLeaveDays,
      proratedDays: p.proratedDays,
      totalWorkingDays: p.totalWorkingDays,
    },
    /// Overtime hour breakdown by type — useful when reconciling
    /// attendance reports against payroll. `otPay` (under `pay`) is
    /// the total RM resulting from these hours.
    overtime: {
      normalHours: p.otNormalHours,
      restHours: p.otRestHours,
      publicHours: p.otPublicHours,
    },
    pay: {
      basic: p.basicPay,
      prorated: p.proratedPay,
      proratedFactor: p.proratedFactor,
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
      epfRates: p.snapshotEpfRates,
      socsoEmployee: p.socsoEmployee,
      socsoEmployer: p.socsoEmployer,
      eisEmployee: p.eisEmployee,
      eisEmployer: p.eisEmployer,
      pcb: p.pcb,
      hrdf: p.hrdf,
      hrdfWage: p.hrdfWage,
      zakat: p.zakat,
      /// SKBBK (Skim LINDUNG 24 Jam) — employee-only PERKESO scheme.
      /// `skbbkEmployee` is the contribution, `skbbkWage` the gazette
      /// wage base it was looked up from, `contributeToSkbbk` the frozen
      /// per-employee opt-in at run time.
      skbbkEmployee: p.skbbkEmployee,
      skbbkWage: p.skbbkWage,
      contributeToSkbbk: p.contributeToSkbbk,
    },
    /// Full line-item breakdown. Every allowance, deduction,
    /// reimbursement, and benefit-in-kind is its own row with the
    /// statutory flags (subjectToEpf etc.) that the calc engine used.
    /// Sorted in the order the calc engine produced them — typically
    /// fixed allowances first, then OT, then manual adjustments, then
    /// reimbursements at the end.
    lineItems: p.lineItems.map((li) => ({
      id: li.id,
      kind: li.kind,
      label: li.label,
      amount: li.amount,
      category: li.category,
      claimId: li.claimId,
      subjectToEpf: li.subjectToEpf,
      subjectToSocso: li.subjectToSocso,
      subjectToEis: li.subjectToEis,
      subjectToPcb: li.subjectToPcb,
    })),
    /// Convenience count — same as `lineItems.length`, but a single
    /// integer for consumers that only want the size without parsing
    /// the array.
    lineItemCount: p.lineItemCount,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}
