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

export const paymentTypes = ["PERSONAL", "COMPANY"] as const
export type PaymentType = (typeof paymentTypes)[number]

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
  receiptUrl?: string
  reviewNotes?: string
  reviewerName?: string
  reviewedAt?: string
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

export type EmployeeClaimSubmissionData = {
  employee: PortalUser
  organization?: OrganizationSummary
  chartAccounts: ChartOfAccountOption[]
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
    autoReviewScore: number
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
