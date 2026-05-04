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

export const employeePayoutMethods = ["HOURLY", "DAILY_BASED"] as const

export type EmployeePayoutMethod = (typeof employeePayoutMethods)[number]

export const employeePayoutMethodLabels: Record<EmployeePayoutMethod, string> = {
  HOURLY: "Hourly worker",
  DAILY_BASED: "Daily-based paid",
}

export function resolveEmployeePayoutMethod(
  role: "EMPLOYEE" | "SUPERVISOR",
  payoutMethod?: string | null,
): EmployeePayoutMethod {
  if (role === "SUPERVISOR") {
    return "DAILY_BASED"
  }

  return payoutMethod === "DAILY_BASED" ? "DAILY_BASED" : "HOURLY"
}

export const mileageUnits = ["KM", "MILE"] as const
export type MileageUnit = (typeof mileageUnits)[number]

export const limitPeriods = ["PER_CLAIM", "MONTHLY", "YEARLY"] as const
export type LimitPeriod = (typeof limitPeriods)[number]

export const limitScopes = ["PER_EMPLOYEE", "ORG_WIDE"] as const
export type LimitScope = (typeof limitScopes)[number]

export type OrganizationSummary = {
  id: string
  name: string
  claimCutoffDay: number
  bankAccount?: string
  otRates: OtRates
  defaultMileageRate?: number
  mileageUnit: MileageUnit
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
  // Spend-limit policy. limitAmount === undefined ⇒ no limit configured.
  limitAmount?: number
  limitPeriod?: LimitPeriod
  limitScope?: LimitScope
  // Mileage flags. allowMileageClaim ⇒ shown in the Mileage claim flow.
  // mileageRate, when set, overrides Organization.defaultMileageRate.
  allowMileageClaim: boolean
  mileageRate?: number
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
  latitude?: number
  longitude?: number
  isManual: boolean
}

export type AssignedProject = {
  id: string
  name: string
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
  projects: AssignedProject[]
  jobTitle: string
  payoutMethod: EmployeePayoutMethod
  supervisorId?: string
  supervisorName?: string
  xeroConnectionId?: string
  xeroConnectionName?: string
  approvalChain: ApprovalChainStep[]
}

export function resolveAssignedProjects(
  legacyProject: string | null | undefined,
  assignedProjects: Array<{ id: string; name: string }> = [],
): AssignedProject[] {
  const seen = new Set<string>()
  const projects: AssignedProject[] = []

  for (const project of assignedProjects) {
    const name = project.name.trim()
    if (!name || seen.has(project.id)) continue
    seen.add(project.id)
    projects.push({ id: project.id, name })
  }

  const normalizedLegacy = legacyProject?.trim()
  if (normalizedLegacy && !projects.some((project) => project.name === normalizedLegacy)) {
    projects.unshift({ id: `legacy:${normalizedLegacy}`, name: normalizedLegacy })
  }

  return projects
}

export function resolvePrimaryProjectName(
  legacyProject: string | null | undefined,
  assignedProjects: Array<{ id: string; name: string }> = [],
): string {
  return resolveAssignedProjects(legacyProject, assignedProjects)[0]?.name ?? "Unknown"
}
