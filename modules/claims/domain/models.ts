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
  "REVIEWED",
  "REJECTED",
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

/**
 * The role of the user who last approved or rejected a claim. Snapshotted
 * onto Claim.reviewerRole at decision time so the admin queue can filter
 * "approved/rejected by supervisor vs admin" without joining to User and
 * without losing the historical fact if the reviewer's role changes later.
 */
export const reviewerRoles = ["SUPERVISOR", "ADMIN"] as const
export type ReviewerRole = (typeof reviewerRoles)[number]

export type ReviewerFilter = ReviewerRole | "ALL"

/**
 * Match a claim against the user's reviewer-filter selection. Claims that
 * have not yet been reviewed (no reviewerRole) only match the "ALL" option —
 * "Supervisor" / "Admin" buckets only contain claims that have actually been
 * acted on by that role.
 */
export function claimMatchesReviewerFilter(
  claim: { reviewerRole?: ReviewerRole },
  filter: ReviewerFilter | undefined
): boolean {
  if (!filter || filter === "ALL") return true
  return claim.reviewerRole === filter
}

export type ReviewDecision = "APPROVED" | "REJECTED"

/**
 * Pure decision function for the claim approval state machine.
 *
 * The current rules (after the workflow simplification):
 *  - REJECTED stays REJECTED, no matter who rejected.
 *  - SUPERVISOR APPROVED → PENDING until the last supervisor signs off.
 *  - Last SUPERVISOR APPROVED → APPROVED, ready for admin review.
 *  - ADMIN APPROVED → REVIEWED. Admin is the final review step.
 *
 * PaymentType (PERSONAL / COMPANY) no longer affects the state machine —
 * both flow through the same path now.
 */
export function decideNextClaimStatus(input: {
  decision: ReviewDecision
  reviewerKind: "SUPERVISOR" | "ADMIN"
  supervisorChainComplete?: boolean
}): "PENDING" | "APPROVED" | "REVIEWED" | "REJECTED" {
  if (input.decision === "REJECTED") return "REJECTED"
  if (input.reviewerKind === "ADMIN") return "REVIEWED"
  return input.supervisorChainComplete ? "APPROVED" : "PENDING"
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
  reviewerRole?: ReviewerRole
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
  /**
   * True when the claim is sitting in PENDING with all supervisor chain
   * steps already approved (or the chain is empty / the claim is SUBMITTED
   * with no chain at all). The admin's "Final approve" button on the admin
   * claims table reads this flag to decide whether to render.
   */
  awaitingAdminFinalApproval: boolean
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
  /** Admin-selected BANK accounts employees can choose for COMPANY-money claims. */
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
