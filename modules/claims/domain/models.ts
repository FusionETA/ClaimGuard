export const claimCategories = [
  "TRAVEL",
  "TRANSPORT",
  "MEAL",
  "MEDICAL",
  "WELLNESS",
  "HARDWARE",
  "OFFICE",
  "OTHER",
] as const

export const claimStatuses = [
  "SUBMITTED",
  "PENDING",
  "APPROVED",
  "REJECTED",
  "PAID",
] as const

export type ClaimCategory = (typeof claimCategories)[number]
export type ClaimStatus = (typeof claimStatuses)[number]

export type PortalUser = {
  name: string
  email: string
  employeeId: string
  role: "EMPLOYEE" | "SUPERVISOR" | "ADMIN"
  project: string
  jobTitle: string
  initials: string
  supervisorEmail?: string
  supervisorName?: string
  payoutMethod?: string
  preferredCurrency?: string
}

export type AdminProfile = {
  name: string
  role: string
  email: string
  initials: string
}

export type ClaimRecord = {
  id: string
  claimNumber: string
  title: string
  description: string
  category: ClaimCategory
  amount: number
  currency: string
  spentAt: string
  submittedAt: string
  status: ClaimStatus
  receiptUrl?: string
  reviewNotes?: string
  reviewerName?: string
  employee: PortalUser
}

export type CreateClaimInput = {
  title: string
  description: string
  category: ClaimCategory
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
  preferences: {
    notifications: boolean
    weeklyDigest: boolean
    expensePolicyVersion: string
  }
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

export type OrganizationMember = {
  id: string
  name: string
  email: string
  role: "EMPLOYEE" | "SUPERVISOR"
  employeeId: string
  project: string
  jobTitle: string
  supervisorId?: string
  supervisorName?: string
}
