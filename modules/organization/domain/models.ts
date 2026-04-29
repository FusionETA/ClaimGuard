export type OrganizationSummary = {
  id: string
  name: string
  claimCutoffDay: number
}

export type ChartOfAccountOption = {
  id: string
  code: string
  name: string
  type?: string
  status?: string
  isSelectable: boolean
  isCustom: boolean
  xeroConnectionId?: string
}

export type OrganizationProjectOption = {
  id: string
  xeroProjectId: string | null
  name: string
  status?: string
  contactId?: string
  xeroConnectionId: string | null
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
}
