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
  // Daily working minutes after which extra time becomes OT-eligible.
  dailyThresholdMinutes: number
}

export const otPayoutMethods = ["CASH", "TIME_BANK"] as const

export type OtPayoutMethod = (typeof otPayoutMethods)[number]

export const otPayoutMethodLabels: Record<OtPayoutMethod, string> = {
  CASH: "Cash out",
  TIME_BANK: "Time balance",
}

export const employeePayoutMethods = ["HOURLY", "MONTHLY_BASED"] as const

export type EmployeePayoutMethod = (typeof employeePayoutMethods)[number]

export const employeePayoutMethodLabels: Record<EmployeePayoutMethod, string> = {
  HOURLY: "Hourly Worker",
  MONTHLY_BASED: "Office Worker",
}

export function resolveEmployeePayoutMethod(
  role: "EMPLOYEE" | "SUPERVISOR",
  payoutMethod?: string | null,
): EmployeePayoutMethod {
  if (role === "SUPERVISOR") {
    return "MONTHLY_BASED"
  }

  return payoutMethod === "MONTHLY_BASED" ? "MONTHLY_BASED" : "HOURLY"
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
  otRates: OtRates
  otEnabled: boolean
  defaultMileageRate?: number
  mileageUnit: MileageUnit
  geofenceRadiusMeters: number
  /// ISO 4217 codes the admin has enabled for this org. Drives the
  /// employee claim form's currency picker. Empty array = nothing
  /// configured yet.
  allowedCurrencies: string[]
  /// Default currency used when AI can't detect one and the user hasn't
  /// picked. ISO 4217 code, or undefined if the admin hasn't set it
  /// (the claim service falls back to "MYR" in that case).
  defaultCurrency?: string
  /// When true, the attendance Trends tab renders the supervisor
  /// performance card. When false the card is hidden entirely.
  supervisorReportEnabled: boolean
  /// SLA in minutes for flagging an approval as "slow" (event-to-review).
  supervisorSlaMinutes: number
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
  xeroConnectionId?: string
  /// Legacy single-PM column (XeroProject.projectManagerId). Kept only to
  /// avoid breaking older callers; all new code reads from projectManagers
  /// (the join-table-backed array) below.
  projectManagerId?: string
  projectManagerName?: string
  /// All project managers assigned to this project, via the ProjectManager
  /// join table. Empty array when nobody is assigned. Each entry is a
  /// SUPERVISOR or ADMIN user.
  projectManagers: Array<{ userId: string; name: string }>
  location?: string
  latitude?: number
  longitude?: number
  isManual: boolean
  workingHoursStart?: string | null
  workingHoursEnd?: string | null
  workingDays?: string | null
  holidays?: ReadonlyArray<{ id: string; date: string; name: string }>
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
  /** True when the developer has bumped XERO_REAUTH_VERSION and this
   *  connection's lastReauthVersion column doesn't match yet. Drives the
   *  "Update permissions" button visibility in the admin UI. */
  requiresReauth: boolean
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

/// One step of the chain. Multiple approvers per step are allowed
/// (any-of approval) — once any of them approves, the step is done.
export type TeamChainStep = {
  step: number
  approvers: Array<{ approverId: string; approverName: string }>
}

export type MemberTeamInfo = {
  membershipId: string
  teamId: string
  teamName: string
  projectId: string
  projectName: string
  layer: number
  /// Per-step chain entries above the employee's layer. Each step holds
  /// the SET of approvers eligible at that step.
  chain: TeamChainStep[]
}

export type OrganizationMember = {
  id: string
  /// `EmployeeProfile.id` for this member. Different from `employeeId`
  /// (the human-readable code like "EMP-001") and from `id` (the User
  /// id). The external API surfaces this so partners can call
  /// `POST /api/v1/teams/[id]/members` (which keys on profile id).
  employeeProfileId?: string
  name: string
  email: string
  role: "EMPLOYEE" | "SUPERVISOR"
  organizationId?: string
  organizationName?: string
  employeeId: string
  projects: AssignedProject[]
  jobTitle: string
  payoutMethod: EmployeePayoutMethod
  otPayoutMethod: OtPayoutMethod
  otTimeBalanceMin: number
  xeroConnectionId?: string
  xeroConnectionName?: string
  /// Assigned employee policy. Drives the salary/OT/module-access fields
  /// above; the admin UI shows a Policy dropdown instead of the legacy
  /// pair of "Employee type" / "OT payout" selectors.
  policyId?: string
  policyName?: string
  /// One team membership per project the employee is in. Each membership
  /// carries its own chain. Empty when the employee has no team yet
  /// (e.g. before backfill).
  teams: MemberTeamInfo[]
}

export function resolveAssignedProjects(
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

  return projects
}

export function resolvePrimaryProjectName(
  assignedProjects: Array<{ id: string; name: string }> = [],
): string {
  return resolveAssignedProjects(assignedProjects)[0]?.name ?? "Unknown"
}

// ---------------------------------------------------------------------------
// Team-based approval templates
// ---------------------------------------------------------------------------
//
// Each XeroProject can host multiple Teams. A Team has a fixed number of
// hierarchy layers and a per-module config that says which layers must
// approve for each module. Each employee belongs to exactly one Team per
// project, at a specific layer.
//
// Approval routing is module-aware: for module M, only chain steps whose
// approver sits at a layer in `moduleConfig[M]` actually need to approve.

export const teamModules = ["CLAIMS", "OT", "LEAVE", "ATTENDANCE"] as const
export type TeamModule = (typeof teamModules)[number]

/// Map of module → 1-indexed layer numbers that must approve. A module with
/// an empty array means "no layers approve" (auto-approve), which is rare;
/// the default is "every layer approves".
export type TeamModuleConfig = Record<TeamModule, number[]>

export type TeamSummary = {
  id: string
  projectId: string
  projectName: string
  name: string
  layerCount: number
  layerLabels?: string[]
  moduleConfig: TeamModuleConfig
  memberCount: number
}

export type TeamMembership = {
  id: string
  employeeProfileId: string
  userId: string
  name: string
  role: "EMPLOYEE" | "SUPERVISOR"
  layer: number
  teamId: string
}

export type TeamDetail = TeamSummary & {
  members: TeamMembership[]
}

export function defaultModuleConfig(layerCount: number): TeamModuleConfig {
  const layers = Array.from({ length: Math.max(1, layerCount) }, (_, i) => i + 1)
  return {
    CLAIMS: layers.slice(),
    OT: layers.slice(),
    LEAVE: layers.slice(),
    ATTENDANCE: layers.slice(),
  }
}

/// Validate a TeamModuleConfig: every key must be a known module, every
/// value must be a (possibly empty) array of unique 1..layerCount integers.
export function validateModuleConfig(
  cfg: unknown,
  layerCount: number,
): { ok: true; value: TeamModuleConfig } | { ok: false; error: string } {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    return { ok: false, error: "moduleConfig must be an object" }
  }
  const out: TeamModuleConfig = {
    CLAIMS: [],
    OT: [],
    LEAVE: [],
    ATTENDANCE: [],
  }
  for (const m of teamModules) {
    const raw = (cfg as Record<string, unknown>)[m]
    if (raw === undefined) {
      // Missing key — treat as "no layers approve" (caller will normally
      // pre-populate with defaultModuleConfig before passing in).
      out[m] = []
      continue
    }
    if (!Array.isArray(raw)) {
      return { ok: false, error: `moduleConfig.${m} must be an array` }
    }
    const seen = new Set<number>()
    const layers: number[] = []
    for (const v of raw) {
      if (typeof v !== "number" || !Number.isInteger(v)) {
        return { ok: false, error: `moduleConfig.${m} contains non-integer value` }
      }
      if (v < 1 || v > layerCount) {
        return {
          ok: false,
          error: `moduleConfig.${m} layer ${v} is out of range 1..${layerCount}`,
        }
      }
      if (seen.has(v)) continue
      seen.add(v)
      layers.push(v)
    }
    layers.sort((a, b) => a - b)
    out[m] = layers
  }
  return { ok: true, value: out }
}

/// Trim a moduleConfig to a new layerCount (used when the admin shrinks a
/// team's layer count: drop any layer numbers that are now out of range).
export function trimModuleConfig(
  cfg: TeamModuleConfig,
  layerCount: number,
): TeamModuleConfig {
  const out: TeamModuleConfig = {
    CLAIMS: [],
    OT: [],
    LEAVE: [],
    ATTENDANCE: [],
  }
  for (const m of teamModules) {
    out[m] = cfg[m].filter((layer) => layer >= 1 && layer <= layerCount)
  }
  return out
}
