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
] as const

export type ClaimStatus = (typeof claimStatuses)[number]

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

export type ClaimRecord = {
  id: string
  claimNumber: string
  title: string
  description: string
  organizationName?: string
  chartOfAccount?: ChartOfAccountOption
  amount: number
  currency: string
  spentAt: string
  submittedAt: string
  claimRunMonth?: string
  status: ClaimStatus
  receiptUrl?: string
  reviewNotes?: string
  reviewerName?: string
  employee: PortalUser
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
