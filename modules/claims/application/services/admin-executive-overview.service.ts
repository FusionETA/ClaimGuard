import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getOrSetCache } from "@/lib/cache"
import { toNumber } from "@/lib/decimal"
import { key } from "@/lib/redis"
import { executiveOverviewRepository } from "@/modules/claims/infrastructure/executive-overview.repository"
import {
  getActiveAdminClaimPaymentTypeScope,
  getActiveAdminEmployeeIdScope,
} from "@/modules/organization/application/services/admin-access.service"
import { resolveAssignedProjects } from "@/modules/organization/domain/models"

function paymentTypeTag(
  paymentTypes: Array<"PERSONAL" | "COMPANY"> | undefined,
): string {
  if (!paymentTypes) return "_all"
  if (paymentTypes.length === 0) return "_none"
  return `t:${[...paymentTypes].sort().join(",")}`
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProjectClaimSpend = {
  project: string
  totalAmount: number
  claimCount: number
}

export type AttendanceProjectHealth = {
  project: string
  total: number
  onTime: number
  late: number
  missing: number
  onLeave: number
}

export type SlowOtApprover = {
  reviewerId: string
  reviewerName: string
  averageHours: number
  reviewedCount: number
  pendingCount: number
}

export type StalePendingClaim = {
  id: string
  claimNumber: string
  title: string
  amount: number
  daysPending: number
  employeeName: string
}

export type UpcomingClaimRun = {
  cutoffDay: number
  cutoffDate: string
  daysUntilCutoff: number
  claimsInRun: number
  pendingInRun: number
  totalAmountInRun: number
}

export type OverturnedSupervisor = {
  supervisorId: string
  supervisorName: string
  /** # of times this layer-1 approver had a claim later rejected by a higher layer. */
  overturnedCount: number
  /** Distinct employees whose claim came back rejected. */
  affectedEmployees: number
}

export type AdminExecutiveOverview = {
  projectSpend: ProjectClaimSpend[]
  attendanceHealth: AttendanceProjectHealth[]
  slowOtApprovers: SlowOtApprover[]
  stalePendingClaims: StalePendingClaim[]
  upcomingClaimRun: UpcomingClaimRun | null
  overturnedSupervisors: {
    total: number
    samples: OverturnedSupervisor[]
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999)
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function daysBetween(a: Date, b: Date) {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000)
}

// `num` was a local Prisma-Decimal coercion helper — replaced by `toNumber`
// from `lib/decimal.ts` (same behaviour, single source of truth).
const num = (value: unknown): number => toNumber(value, 0)

// ─── Service ──────────────────────────────────────────────────────────────────

const STALE_PENDING_DAYS = 7
const SLOW_OT_THRESHOLD_HOURS = 24
const SLOW_OT_LOOKBACK_DAYS = 60

export async function getAdminExecutiveOverview(): Promise<AdminExecutiveOverview | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null

  const orgId = resolveActiveOrgId(session) ?? null
  if (!orgId) {
    return {
      projectSpend: [],
      attendanceHealth: [],
      slowOtApprovers: [],
      stalePendingClaims: [],
      upcomingClaimRun: null,
      overturnedSupervisors: { total: 0, samples: [] },
    }
  }

  // Month boundary (YYYY-MM) is part of the key so a month rollover
  // surfaces fresh data without waiting for TTL. Stale-pending counts +
  // OT lookbacks are 30/60/90-day windows that slide daily, but the
  // 60s TTL bounds that staleness — admins viewing the overview see at
  // most a 1-minute lag even on a heavily-cached page.
  const now = new Date()
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  // Resolve scope at the cache-key layer so two admins with different
  // grants don't share a stale aggregate. `null` (owner / legacy)
  // collapses to "_all" so existing entries remain hot.
  const [restrictToEmployeeIds, paymentTypes] = await Promise.all([
    getActiveAdminEmployeeIdScope(orgId),
    getActiveAdminClaimPaymentTypeScope(),
  ])
  const scopeTag =
    restrictToEmployeeIds === null
      ? "_all"
      : `emp:${[...restrictToEmployeeIds].sort().join(",")}`
  return getOrSetCache(
    key(
      "org",
      orgId,
      "exec-overview",
      monthKey,
      scopeTag,
      paymentTypeTag(paymentTypes),
    ),
    60,
    () => loadAdminExecutiveOverview(orgId, restrictToEmployeeIds, paymentTypes),
  )
}

async function loadAdminExecutiveOverview(
  orgId: string,
  restrictToEmployeeIds: string[] | null,
  paymentTypes: Array<"PERSONAL" | "COMPANY"> | undefined,
): Promise<AdminExecutiveOverview> {
  const now = new Date()
  const monthStart = startOfMonth(now)
  const monthEnd = endOfMonth(now)
  const last30Days = new Date(now.getTime() - 30 * 86_400_000)
  const staleCutoff = new Date(now.getTime() - STALE_PENDING_DAYS * 86_400_000)
  const otLookback = new Date(now.getTime() - SLOW_OT_LOOKBACK_DAYS * 86_400_000)
  const overturnLookback = new Date(now.getTime() - 90 * 86_400_000)

  // The admin's allowed employee scope + claim-type filter were
  // already resolved by the cached wrapper. Build the option bag the
  // repo methods take. Claim queries get both filters; OT / attendance
  // / chain-step queries only take the employee scope (paymentTypes
  // doesn't apply to them).
  const scopeOpt = { restrictToEmployeeIds }
  const claimScopeOpt = { restrictToEmployeeIds, paymentTypes }

  // Each call below maps 1:1 to a query that used to live inline as raw
  // `prisma.*.findMany` — moved into `executive-overview.repository.ts` so
  // the service stays orchestration-only, per the layered architecture rule.
  const [
    monthClaims,
    attendanceRecords,
    otReviewed,
    otPending,
    pendingClaims,
    cutoffDay,
    runClaims,
    rejectedClaims,
    chainStepRows,
  ] = await Promise.all([
    executiveOverviewRepository.getMonthClaimsForOrg(orgId, monthStart, monthEnd, claimScopeOpt),
    executiveOverviewRepository.getAttendanceRecordsForOrg(orgId, last30Days, now, scopeOpt),
    executiveOverviewRepository.getReviewedOtApprovalsForOrg(orgId, otLookback, scopeOpt),
    executiveOverviewRepository.getPendingOtApprovalsForOrg(orgId, scopeOpt),
    executiveOverviewRepository.getStalePendingClaims(orgId, staleCutoff, 5, claimScopeOpt),
    executiveOverviewRepository.getOrgClaimCutoffDay(orgId),
    executiveOverviewRepository.getClaimsInRunForOrg(orgId, monthStart, monthEnd, claimScopeOpt),
    executiveOverviewRepository.getRejectedClaimsSinceForOrg(orgId, overturnLookback, claimScopeOpt),
    executiveOverviewRepository.getChainStepsForOrg(orgId, scopeOpt),
  ])

  // ── 1. Project claims breakdown ────────────────────────────────────────────
  const projectMap = new Map<string, ProjectClaimSpend>()
  for (const c of monthClaims) {
    // Match the detail dialog's resolution order: claim's own
    // `projectId` → employee's primary project assignment → "Unassigned".
    const assignedProjects = (
      c.employee?.employeeProfiles[0]?.projectAssignments ?? []
    ).map((a: { project: { id: string; name: string } }) => ({
      id: a.project.id,
      name: a.project.name,
    }))
    const primaryAssigned = resolveAssignedProjects(assignedProjects)[0]
    const project =
      c.project?.name?.trim() || primaryAssigned?.name?.trim() || "Unassigned"
    const amount = num(c.amount)
    const row = projectMap.get(project) ?? { project, totalAmount: 0, claimCount: 0 }
    row.totalAmount += amount
    row.claimCount += 1
    projectMap.set(project, row)
  }
  const projectSpend = Array.from(projectMap.values())
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, 5)

  // ── 2. Attendance health by project ────────────────────────────────────────
  const attendanceMap = new Map<string, AttendanceProjectHealth>()
  for (const r of attendanceRecords) {
    const project =
      r.project?.trim() ||
      r.projectRef?.name?.trim() ||
      "Unassigned"
    const row =
      attendanceMap.get(project) ??
      { project, total: 0, onTime: 0, late: 0, missing: 0, onLeave: 0 }
    row.total += 1
    if (r.status === "ON_TIME" || r.status === "CLOCKED_IN" || r.status === "CLOCKED_OUT") {
      row.onTime += 1
    } else if (r.status === "LATE") row.late += 1
    else if (r.status === "MISSING") row.missing += 1
    else if (r.status === "ON_LEAVE") row.onLeave += 1
    attendanceMap.set(project, row)
  }
  const attendanceHealth = Array.from(attendanceMap.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)

  // ── 3. Slow OT approvers ───────────────────────────────────────────────────
  const reviewerStats = new Map<
    string,
    { reviewerId: string; reviewerName: string; totalHours: number; reviewedCount: number }
  >()
  for (const r of otReviewed) {
    if (!r.reviewerId || !r.reviewedAt || !r.submittedAt) continue
    const hours = (r.reviewedAt.getTime() - r.submittedAt.getTime()) / 3_600_000
    if (hours < 0) continue
    const stats =
      reviewerStats.get(r.reviewerId) ??
      {
        reviewerId: r.reviewerId,
        reviewerName: r.reviewer?.name ?? "Unknown",
        totalHours: 0,
        reviewedCount: 0,
      }
    stats.totalHours += hours
    stats.reviewedCount += 1
    reviewerStats.set(r.reviewerId, stats)
  }

  // Pending OT count per supervisor — derived from each employee's first
  // approval chain step (the team chain replaces the legacy single-pointer
  // EmployeeProfile.supervisorId).
  const firstStepApproverByEmployee = new Map<string, string>()
  for (const row of chainStepRows) {
    if (!firstStepApproverByEmployee.has(row.employeeId)) {
      firstStepApproverByEmployee.set(row.employeeId, row.approverId)
    }
  }
  const pendingPerSupervisor = new Map<string, number>()
  for (const r of otPending) {
    const sid = firstStepApproverByEmployee.get(r.employeeId)
    if (!sid) continue
    pendingPerSupervisor.set(sid, (pendingPerSupervisor.get(sid) ?? 0) + 1)
  }

  const slowOtApprovers: SlowOtApprover[] = Array.from(reviewerStats.values())
    .map((s) => ({
      reviewerId: s.reviewerId,
      reviewerName: s.reviewerName,
      averageHours: s.totalHours / s.reviewedCount,
      reviewedCount: s.reviewedCount,
      pendingCount: pendingPerSupervisor.get(s.reviewerId) ?? 0,
    }))
    .filter((s) => s.averageHours > SLOW_OT_THRESHOLD_HOURS)
    .sort((a, b) => b.averageHours - a.averageHours)
    .slice(0, 5)

  // ── 4. Stale pending claims ────────────────────────────────────────────────
  const stalePendingClaims: StalePendingClaim[] = pendingClaims.map((c) => ({
    id: c.id,
    claimNumber: c.claimNumber,
    title: c.title,
    amount: num(c.amount),
    daysPending: daysBetween(startOfDay(now), startOfDay(c.submittedAt)),
    employeeName: c.employee?.name ?? "Unknown",
  }))

  // ── 5. Upcoming claim run ──────────────────────────────────────────────────
  let upcomingClaimRun: UpcomingClaimRun | null = null
  if (cutoffDay != null) {
    // Next cutoff date: this month's cutoff if not yet passed, else next month's
    let cutoffDate = new Date(now.getFullYear(), now.getMonth(), cutoffDay, 23, 59, 59, 999)
    if (cutoffDate.getTime() < now.getTime()) {
      cutoffDate = new Date(now.getFullYear(), now.getMonth() + 1, cutoffDay, 23, 59, 59, 999)
    }
    const daysUntilCutoff = Math.max(
      0,
      Math.ceil((cutoffDate.getTime() - now.getTime()) / 86_400_000)
    )
    let claimsInRun = 0
    let pendingInRun = 0
    let totalAmountInRun = 0
    for (const c of runClaims) {
      claimsInRun += 1
      totalAmountInRun += num(c.amount)
      if (c.status === "PENDING" || c.status === "SUBMITTED") pendingInRun += 1
    }
    upcomingClaimRun = {
      cutoffDay,
      cutoffDate: cutoffDate.toISOString(),
      daysUntilCutoff,
      claimsInRun,
      pendingInRun,
      totalAmountInRun,
    }
  }

  // ── 6. Layer-1 supervisors most often overturned by a higher layer ─────────
  // Group chain steps by employee for O(1) lookup.
  type ChainEntry = (typeof chainStepRows)[number]
  const chainsByEmployee = new Map<string, ChainEntry[]>()
  for (const row of chainStepRows) {
    const list = chainsByEmployee.get(row.employeeId) ?? []
    list.push(row)
    chainsByEmployee.set(row.employeeId, list)
  }

  // For each REJECTED claim: if the rejecter sits at step ≥ 2 in the chain,
  // the layer-1 (step 1) supervisor for that employee gets one overturn tally.
  // (Their step-1 approval was overruled further up the chain.)
  const overturnStats = new Map<
    string,
    {
      supervisorId: string
      supervisorName: string
      overturnedCount: number
      affectedEmployees: Set<string>
    }
  >()
  for (const claim of rejectedClaims) {
    if (!claim.lastReviewerId) continue
    const chain = chainsByEmployee.get(claim.employeeId)
    if (!chain || chain.length < 2) continue // need at least 2 layers to "overturn"

    const rejecterStep = chain.find((s) => s.approverId === claim.lastReviewerId)
    if (!rejecterStep || rejecterStep.step < 2) continue

    const layer1 = chain.find((s) => s.step === chain[0]!.step) // step 1 (lowest step number)
    if (!layer1) continue

    const stats = overturnStats.get(layer1.approverId) ?? {
      supervisorId: layer1.approverId,
      supervisorName: layer1.approver.name,
      overturnedCount: 0,
      affectedEmployees: new Set<string>(),
    }
    stats.overturnedCount += 1
    stats.affectedEmployees.add(claim.employeeId)
    overturnStats.set(layer1.approverId, stats)
  }

  const overturnedSamples: OverturnedSupervisor[] = Array.from(overturnStats.values())
    .map((s) => ({
      supervisorId: s.supervisorId,
      supervisorName: s.supervisorName,
      overturnedCount: s.overturnedCount,
      affectedEmployees: s.affectedEmployees.size,
    }))
    .sort((a, b) => b.overturnedCount - a.overturnedCount)
    .slice(0, 3)

  const overturnedSupervisors = {
    total: Array.from(overturnStats.values()).reduce(
      (sum, s) => sum + s.overturnedCount,
      0
    ),
    samples: overturnedSamples,
  }

  return {
    projectSpend,
    attendanceHealth,
    slowOtApprovers,
    stalePendingClaims,
    upcomingClaimRun,
    overturnedSupervisors,
  }
}
