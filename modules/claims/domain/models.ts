import type {
  ChartOfAccountOption,
  EmployeePayoutMethod,
  OrganizationProjectOption,
  OrganizationSummary,
  XeroConnectionSummary,
} from "@/modules/organization/domain/models"

export const claimStatuses = [
  "SUBMITTED",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PAID",
  "SETTLED",
] as const

export type ClaimStatus = (typeof claimStatuses)[number]

/**
 * The set of statuses we surface in the UI's status-filter dropdown. We hide
 * "SUBMITTED" because it gets folded into "PENDING" for filter purposes —
 * see `claimMatchesStatusFilter` below.
 */
export const visibleStatusOptions: ReadonlyArray<ClaimStatus> = claimStatuses.filter(
  (status) => status !== "SUBMITTED"
) as ReadonlyArray<ClaimStatus>

export type ClaimStatusFilter = ClaimStatus | "ALL"

/**
 * Single source of truth for "does this claim match the user's status
 * filter selection?". The "PENDING" filter intentionally also matches
 * "SUBMITTED" claims (newly-submitted claims awaiting first review) so the
 * supervisor and admin queues don't have to remember to OR in SUBMITTED.
 */
export function claimMatchesStatusFilter(
  claim: { status: ClaimStatus },
  filter: ClaimStatusFilter | undefined
): boolean {
  if (!filter || filter === "ALL") return true
  if (filter === "PENDING") {
    return claim.status === "PENDING" || claim.status === "SUBMITTED"
  }
  return claim.status === filter
}

export const paymentTypes = ["PERSONAL", "COMPANY"] as const
export type PaymentType = (typeof paymentTypes)[number]

export const claimTypes = ["EXPENSE", "MILEAGE"] as const
export type ClaimType = (typeof claimTypes)[number]

export type ReviewDecision = "APPROVED" | "REJECTED"

/**
 * Pure decision function for the claim approval state machine. Replaces the
 * three near-identical inline branches that lived inside the repository's
 * `reviewClaim` method.
 *
 * Rules:
 *  - REJECTED stays REJECTED, no matter what.
 *  - APPROVED but the reviewer is *not* the final step → PENDING (next layer).
 *  - APPROVED + final step + COMPANY money → SETTLED. Company has already
 *    paid out of its own account; there is no separate "mark as paid" step.
 *  - APPROVED + final step + PERSONAL money → APPROVED. Admin still needs
 *    to mark it paid afterwards.
 *
 * For admin reviews and legacy (no-chain) supervisor reviews, callers pass
 * `isFinalStep: true` since both paths skip the multi-layer chain.
 */
export function decideNextClaimStatus(input: {
  decision: ReviewDecision
  isFinalStep: boolean
  isCompanyMoney: boolean
}): "PENDING" | "APPROVED" | "REJECTED" | "SETTLED" {
  if (input.decision === "REJECTED") return "REJECTED"
  if (!input.isFinalStep) return "PENDING"
  return input.isCompanyMoney ? "SETTLED" : "APPROVED"
}

export type ClaimRunPreview = {
  claimCutoffDay: number
  submittedOn: string
  targetMonth: string
  targetLabel: string
  isCurrentMonth: boolean
}

export type PortalUser = {
  name: string
  email: string
  employeeId: string
  role: "EMPLOYEE" | "SUPERVISOR" | "ADMIN"
  organizationId?: string
  organizationName?: string
  project: string
  projects: string[]
  jobTitle: string
  initials: string
  supervisorEmail?: string
  supervisorName?: string
  payoutMethod?: EmployeePayoutMethod
  preferredCurrency?: string
  xeroConnectionId?: string
  xeroConnectionName?: string
}

export type AdminProfile = {
  name: string
  role: string
  email: string
  initials: string
  organizationId?: string
  organizationName?: string
}

export type ApprovalStepState =
  | "approved"
  | "current"
  | "upcoming"
  | "rejected"
  | "skipped"

export type ApprovalStepInfo = {
  step: number
  approverId: string
  name: string
  email: string
  role: "EMPLOYEE" | "SUPERVISOR" | "ADMIN"
  state: ApprovalStepState
  reviewedAt?: string
  reviewNotes?: string
}

export type PendingApproverInfo = {
  approverId: string
  name: string
  email: string
  step: number
  totalSteps: number
}

export type ClaimRecord = {
  id: string
  claimNumber: string
  title: string
  description: string
  organizationName?: string
  chartOfAccount?: ChartOfAccountOption
  payViaAccount?: ChartOfAccountOption
  amount: number
  currency: string
  spentAt: string
  submittedAt: string
  claimRunMonth?: string
  status: ClaimStatus
  paymentType: PaymentType
  claimType: ClaimType
  receiptUrl?: string
  reviewNotes?: string
  reviewerName?: string
  reviewedAt?: string
  // Mileage snapshot — populated only when claimType === "MILEAGE".
  distance?: number
  mileageOriginAddress?: string
  mileageDestinationAddress?: string
  mileageRateUsed?: number
  mileageUnitUsed?: "KM" | "MILE"
  employee: PortalUser
  pendingApprover?: PendingApproverInfo
  approvalChain?: ApprovalStepInfo[]
}

export type CreateClaimInput = {
  title: string
  description: string
  chartOfAccountId: string
  amount: number
  spentAt: Date
  receiptUrl?: string
}

export type CreateClaimResult = {
  persisted: boolean
  message: string
}

export type EmployeeDashboardData = {
  employee: PortalUser
  organization?: OrganizationSummary
  totals: {
    reimbursed: number
    pending: number
    approved: number
    paid: number
  }
  recentClaims: ClaimRecord[]
}

export type EmployeeAccountData = {
  employee: PortalUser
  organization?: OrganizationSummary
  preferences: {
    notifications: boolean
    weeklyDigest: boolean
    expensePolicyVersion: string
  }
}

export type ChartAccountWithRemainingLimit = ChartOfAccountOption & {
  /**
   * Pre-computed "X used of Y" for the current period, so the form can show
   * a hint without making an extra request. null when the account has no limit.
   */
  remainingLimit?: {
    limit: number
    used: number
    remaining: number
    period: "PER_CLAIM" | "MONTHLY" | "YEARLY"
    scope: "PER_EMPLOYEE" | "ORG_WIDE"
  } | null
}

export type EmployeeClaimSubmissionData = {
  employee: PortalUser
  organization?: OrganizationSummary
  chartAccounts: ChartAccountWithRemainingLimit[]
  /** Mileage-eligible accounts only, separate from expense accounts. */
  mileageAccounts: ChartAccountWithRemainingLimit[]
  bankAccounts: ChartOfAccountOption[]
  claimRunPreview?: ClaimRunPreview
}

export type AdminDashboardData = {
  admin: AdminProfile
  totals: {
    totalClaims: number
    pending: number
    approvedValue: number
    paidValue: number
  }
  alerts: {
    highValue: number
    readyForPayout: number
  }
  monthlyVolume: Array<{
    month: string
    total: number
  }>
  queue: ClaimRecord[]
}

export type AdminSettingsData = {
  admin: AdminProfile
  organization?: OrganizationSummary
  xeroConnection: XeroConnectionSummary
  chartAccounts: ChartOfAccountOption[]
  projects: OrganizationProjectOption[]
}
