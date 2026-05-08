import type { ClaimRecord } from "@/modules/claims/domain/models"

/**
 * External claim shape — single projection used by every claim
 * endpoint (list, per-id GET, review action, sync action) so the
 * partner sees one consistent contract.
 *
 * Lives in `_shared.ts` (private to this folder per Next.js naming
 * convention; `_`-prefixed files aren't treated as routes) so
 * `route.ts`-eligible files don't have to non-default-export the
 * helper, which Next.js's route runtime rejects.
 */
export function toExternalClaim(claim: ClaimRecord) {
  return {
    id: claim.id,
    claimNumber: claim.claimNumber,
    title: claim.title,
    description: claim.description,
    status: claim.status,
    claimType: claim.claimType,
    paymentType: claim.paymentType,
    amount: claim.amount,
    currency: claim.currency,
    spentAt: claim.spentAt,
    submittedAt: claim.submittedAt,
    claimRunMonth: claim.claimRunMonth ?? null,
    exceedsLimit: claim.exceedsLimit ?? false,
    awaitingAdminFinalApproval: claim.awaitingAdminFinalApproval,
    employee: {
      id: claim.employee.employeeId,
      employeeId: claim.employee.employeeId,
      name: claim.employee.name,
      email: claim.employee.email,
      jobTitle: claim.employee.jobTitle,
    },
    chartOfAccount: claim.chartOfAccount
      ? {
          id: claim.chartOfAccount.id,
          code: claim.chartOfAccount.code,
          name: claim.chartOfAccount.name,
        }
      : null,
    receiptUrl: claim.receiptUrl ?? null,
    reviewedAt: claim.reviewedAt ?? null,
    reviewerName: claim.reviewerName ?? null,
    reviewerRole: claim.reviewerRole ?? null,
    reviewNotes: claim.reviewNotes ?? null,
    pendingApprover: claim.pendingApprover
      ? {
          name: claim.pendingApprover.name,
          step: claim.pendingApprover.step,
          totalSteps: claim.pendingApprover.totalSteps,
        }
      : null,
    mileage:
      claim.claimType === "MILEAGE"
        ? {
            distance: claim.distance ?? null,
            originAddress: claim.mileageOriginAddress ?? null,
            destinationAddress: claim.mileageDestinationAddress ?? null,
            rateUsed: claim.mileageRateUsed ?? null,
            unitUsed: claim.mileageUnitUsed ?? null,
          }
        : null,
  }
}
