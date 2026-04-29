export type OtRates = {
  // OT multipliers (× HRP) applied to hours beyond the regular shift.
  normalDay: number
  restDay: number
  publicHoliday: number
  // In-shift premiums (× ORP) applied to hours within the regular shift on
  // rest days / public holidays.
  restDayInShift: number
  publicHolidayInShift: number
  // Salary cap (RM, basic + fixed allowance) above which OT requires
  // management approval.
  salaryThreshold: number
}

export type OrganizationSummary = {
  id: string
  name: string
  claimCutoffDay: number
  bankAccount?: string
  otRates: OtRates
}

export type AdminOrganizationOption = {
  id: string
  name: string
}

export type ChartOfAccountOption = {
  id: string
  code: string
  name: string
  type?: string
  status?: string
  isSelectable: boolean
  isBankAccount: boolean
  isCustom: boolean
  isDisabled: boolean
  xeroConnectionId?: string
}

export type OrganizationProjectOption = {
  id: string
  xeroProjectId?: string
  name: string
  status?: string
  contactId?: string
  xeroConnectionId?: string
  projectManagerId?: string
  projectManagerName?: string
  location?: string
  isManual: boolean
}

export type XeroConnectionInfo = {
  id: string
  tenantId: string
  tenantName: string
  tenantType?: string
  connectedAt: string
  lastTokenRefreshAt: string
}

export type XeroConnectionSummary = {
  configured: boolean
  missingConfig: string[]
  connections: XeroConnectionInfo[]
}

export type ApprovalChainStep = {
  step: number
  approverId: string
  approverName: string
}

export type OrganizationMember = {
  id: string
  name: string
  email: string
  role: "EMPLOYEE" | "SUPERVISOR"
  organizationId?: string
  organizationName?: string
  employeeId: string
  project: string
  jobTitle: string
  supervisorId?: string
  supervisorName?: string
  xeroConnectionId?: string
  xeroConnectionName?: string
  approvalChain: ApprovalChainStep[]
}
