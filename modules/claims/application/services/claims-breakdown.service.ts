import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { getOrSetCache } from "@/lib/cache"
import { key } from "@/lib/redis"
import {
  claimRepository,
  getClaimsPrismaClientSafe,
} from "@/modules/claims/infrastructure/claim.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import type { ClaimRecord } from "@/modules/claims/domain/models"

/// Reports breakdowns are cached under the org "claims" namespace
/// (`org:{orgId}:claims:report:*`), so the existing `bustClaimCaches`
/// (called on every claim submit/review/approve/reject) sweeps them.
/// 5-minute TTL is the backstop.
const REPORT_TTL_SECONDS = 300

/**
 * "By project" breakdown for the admin claims tab. Drills down through:
 *   Projects → Teams (within a project) → Members (within a team) →
 *   Individual claims (filed by that member against that project).
 *
 * Every level is scoped to:
 *   - the admin's active organisation, and
 *   - a single calendar month (defaults to current month, in the org's
 *     timezone — but we normalise to UTC at the boundary because the DB
 *     stores Claim.spentAt as a UTC `DateTime`).
 *
 * `monthKey` is a "yyyy-mm" string we accept from the URL search-param so
 * the page is bookmark-able.
 */

export type MonthKey = string // yyyy-mm

/** Resolve a yyyy-mm key into [start, endExclusive) UTC bounds. Invalid /
 *  missing keys fall back to the current month. */
export function resolveMonthBounds(monthKey?: string | null) {
  const parsed = parseMonthKey(monthKey)
  const now = new Date()
  const target =
    parsed ??
    {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1, // 1..12
    }

  const monthStart = new Date(Date.UTC(target.year, target.month - 1, 1))
  const monthEnd = new Date(Date.UTC(target.year, target.month, 1))
  return {
    monthKey: formatMonthKey(target.year, target.month),
    monthStart,
    monthEnd,
  }
}

function parseMonthKey(key: string | null | undefined) {
  if (!key) return null
  const match = key.match(/^(\d{4})-(\d{2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null
  if (month < 1 || month > 12) return null
  return { year, month }
}

function formatMonthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`
}

/** Build the last N month keys, newest first, including the current
 *  month. Used to populate the month-picker dropdown. */
export function buildMonthOptions(count = 12) {
  const out: { key: string; label: string }[] = []
  const now = new Date()
  let year = now.getUTCFullYear()
  let month = now.getUTCMonth() + 1
  for (let i = 0; i < count; i++) {
    out.push({
      key: formatMonthKey(year, month),
      label: new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-MY", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
    })
    month -= 1
    if (month === 0) {
      month = 12
      year -= 1
    }
  }
  return out
}

async function requireAdminOrgId(): Promise<string | null> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return null
  return resolveActiveOrgId(session) ?? null
}

export async function getProjectsBreakdown(monthKey?: string | null) {
  const organizationId = await requireAdminOrgId()
  if (!organizationId) return null

  const { monthKey: resolvedKey, monthStart, monthEnd } = resolveMonthBounds(monthKey)

  return getOrSetCache(
    key("org", organizationId, "claims", "report", "projects", resolvedKey),
    REPORT_TTL_SECONDS,
    async () => ({
      monthKey: resolvedKey,
      projects: await claimRepository.getProjectsClaimBreakdown({
        organizationId,
        monthStart,
        monthEnd,
      }),
    }),
  )
}

export async function getTeamsBreakdown(input: {
  projectId: string
  monthKey?: string | null
}) {
  const organizationId = await requireAdminOrgId()
  if (!organizationId) return null

  const { monthKey: resolvedKey, monthStart, monthEnd } = resolveMonthBounds(
    input.monthKey,
  )

  return getOrSetCache(
    key("org", organizationId, "claims", "report", "teams", input.projectId, resolvedKey),
    REPORT_TTL_SECONDS,
    async () => ({
      monthKey: resolvedKey,
      teams: await claimRepository.getTeamsClaimBreakdown({
        organizationId,
        projectId: input.projectId,
        monthStart,
        monthEnd,
      }),
    }),
  )
}

export async function getMembersBreakdown(input: {
  projectId: string
  teamId: string
  monthKey?: string | null
}) {
  const organizationId = await requireAdminOrgId()
  if (!organizationId) return null

  const { monthKey: resolvedKey, monthStart, monthEnd } = resolveMonthBounds(
    input.monthKey,
  )

  return getOrSetCache(
    key("org", organizationId, "claims", "report", "members", input.projectId, input.teamId, resolvedKey),
    REPORT_TTL_SECONDS,
    async () => ({
      monthKey: resolvedKey,
      members: await claimRepository.getMembersClaimBreakdown({
        organizationId,
        projectId: input.projectId,
        teamId: input.teamId,
        monthStart,
        monthEnd,
      }),
    }),
  )
}

export async function getMemberClaimsBreakdown(input: {
  projectId: string
  employeeId: string
  monthKey?: string | null
}) {
  const organizationId = await requireAdminOrgId()
  if (!organizationId) return null

  const { monthKey: resolvedKey, monthStart, monthEnd } = resolveMonthBounds(
    input.monthKey,
  )

  return getOrSetCache(
    key("org", organizationId, "claims", "report", "member-claims", input.projectId, input.employeeId, resolvedKey),
    REPORT_TTL_SECONDS,
    async () => ({
      monthKey: resolvedKey,
      claims: await claimRepository.getMemberClaimsForBreakdown({
        organizationId,
        projectId: input.projectId,
        employeeId: input.employeeId,
        monthStart,
        monthEnd,
      }),
    }),
  )
}

// ───────────────────────────────────────────────────────────────────────────
// Reports page (flat, paginated, multi-filter) — replaces the old drill-down
// ───────────────────────────────────────────────────────────────────────────

export type ClaimsReportDateField = "spent" | "submitted"

export type ClaimsReportFilters = {
  /// Inclusive start (yyyy-mm-dd) parsed in UTC.
  from?: string | null
  /// Inclusive end (yyyy-mm-dd) — the service converts to "first instant
  /// of the next day" internally so claims dated on `to` are matched.
  to?: string | null
  /// Which claim timestamp the date range filters on. Defaults to
  /// "spent" because the report is primarily an accounting view ("how
  /// much money was spent in this period?"). Switch to "submitted"
  /// when the admin wants to audit submission velocity, or to find a
  /// claim someone filed last month for a 2024 receipt.
  dateField?: ClaimsReportDateField
  /// Multi-select; empty/undefined = "all projects".
  projects?: string[]
  /// Multi-select; cascades on `projects` (see filterOptions).
  teams?: string[]
  /// Multi-select; cascades on `projects` ∩ `teams`.
  members?: string[]
}

export type ClaimsReportPage = {
  /// Range actually used (after resolving defaults). yyyy-mm-dd strings.
  resolvedFrom: string
  resolvedTo: string
  page: number
  pageSize: number
  rows: ClaimRecord[]
  total: number
  totalAmount: number
  /// Pre-resolved cascading filter options for the filter bar. The
  /// page passes these to the client filter component so it can show
  /// only valid sub-options for the current pick.
  ///
  /// `teams[*].projectId` and `members[*].teamIds` are the parent
  /// linkage the client uses to narrow downstream dropdowns LIVE as
  /// the admin picks a parent — without waiting for an Apply round-
  /// trip to the server.
  filterOptions: {
    projects: Array<{ id: string; name: string }>
    teams: Array<{ id: string; name: string; projectId: string }>
    members: Array<{ id: string; name: string; email: string; teamIds: string[] }>
  }
}

const DEFAULT_PAGE_SIZE = 20

/**
 * Resolve a YYYY-MM-DD string into a UTC Date. Returns null on parse
 * failure so the caller can fall back to the period default.
 */
function parseYmd(value: string | null | undefined): Date | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return new Date(Date.UTC(y, mo - 1, d))
}

function formatYmd(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/**
 * Resolve the date-range bounds for the reports query.
 *
 *   - If both `from` and `to` are valid → use them as-is (inclusive day).
 *   - Otherwise → default to the current calendar month.
 *
 * Returns `dateTo` as the FIRST instant of the day AFTER the chosen end
 * so the repository query (`spentAt < dateTo`) includes claims dated
 * on the end day itself.
 */
function resolveDateRange(filters: ClaimsReportFilters): {
  dateFrom: Date
  dateTo: Date
  resolvedFrom: string
  resolvedTo: string
} {
  const parsedFrom = parseYmd(filters.from)
  const parsedTo = parseYmd(filters.to)
  if (parsedFrom && parsedTo && parsedTo >= parsedFrom) {
    const dateToExclusive = new Date(parsedTo.getTime() + 24 * 60 * 60 * 1000)
    return {
      dateFrom: parsedFrom,
      dateTo: dateToExclusive,
      resolvedFrom: formatYmd(parsedFrom),
      resolvedTo: formatYmd(parsedTo),
    }
  }
  // Default = current month, mirrors the existing breakdown's behaviour.
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const endExclusive = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  )
  const endInclusive = new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000)
  return {
    dateFrom: start,
    dateTo: endExclusive,
    resolvedFrom: formatYmd(start),
    resolvedTo: formatYmd(endInclusive),
  }
}

/**
 * Pulls the data the new /admin/claims/breakdown reports page needs:
 *
 *   - The paginated claim rows + total count + sum of amounts for the
 *     filter selection (so the page can show "20 of 137 · RM 14,202").
 *   - The cascading filter options:
 *       - projects: all projects in the org
 *       - teams:    teams scoped to picked projects (or all if no
 *                   project picked)
 *       - members:  employees scoped to picked teams (or to picked
 *                   projects if only projects are picked, or all)
 */
export async function getClaimsReportPageData(input: {
  filters: ClaimsReportFilters
  page?: number
  pageSize?: number
}): Promise<ClaimsReportPage | null> {
  const organizationId = await requireAdminOrgId()
  if (!organizationId) return null

  const pageSize = Math.max(1, Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, 200))
  const page = Math.max(1, input.page ?? 1)

  // Stable cache signature across the filter selection + pagination so
  // each distinct view caches independently. Arrays are sorted so order
  // doesn't fragment the key. Busted by bustClaimCaches on any claim
  // mutation; 5-min TTL backstop.
  const f = input.filters
  const sig = [
    f.from ?? "",
    f.to ?? "",
    f.dateField ?? "spent",
    (f.projects ?? []).slice().sort().join(","),
    (f.teams ?? []).slice().sort().join(","),
    (f.members ?? []).slice().sort().join(","),
    page,
    pageSize,
  ].join("|")

  return getOrSetCache(
    key("org", organizationId, "claims", "report", "page", sig),
    REPORT_TTL_SECONDS,
    () => loadClaimsReportPage(organizationId, input, page, pageSize),
  )
}

async function loadClaimsReportPage(
  organizationId: string,
  input: { filters: ClaimsReportFilters; page?: number; pageSize?: number },
  page: number,
  pageSize: number,
): Promise<ClaimsReportPage> {
  const { dateFrom, dateTo, resolvedFrom, resolvedTo } = resolveDateRange(
    input.filters,
  )

  // We deliberately return the FULL set of teams and members in the
  // org (with their parent linkage) so the client can narrow the
  // downstream dropdowns LIVE as the admin picks a parent, without
  // waiting for an Apply round-trip. The claim list itself is still
  // scoped server-side from the URL params.
  const prisma = getClaimsPrismaClientSafe()
  const [allProjects, allTeams, allMemberRows, claimsPage] = await Promise.all([
    organizationRepository.getProjectsForOrganization(organizationId),
    organizationRepository.listTeams(organizationId),
    prisma
      ? prisma.user.findMany({
          where: {
            organizationId,
            role: { in: ["EMPLOYEE", "SUPERVISOR"] },
          },
          select: {
            id: true,
            name: true,
            email: true,
            employeeProfiles: {
              select: {
                teamMemberships: { select: { teamId: true } },
              },
            },
          },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    claimRepository.listClaimsForReports({
      organizationId,
      dateFrom,
      dateTo,
      dateField: input.filters.dateField ?? "spent",
      projectIds: nonEmpty(input.filters.projects),
      teamIds: nonEmpty(input.filters.teams),
      memberIds: nonEmpty(input.filters.members),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  return {
    resolvedFrom,
    resolvedTo,
    page,
    pageSize,
    rows: claimsPage.rows,
    total: claimsPage.total,
    totalAmount: claimsPage.totalAmount,
    filterOptions: {
      projects: allProjects.map((p) => ({ id: p.id, name: p.name })),
      teams: allTeams.map((t) => ({
        id: t.id,
        name: t.name,
        projectId: t.projectId,
      })),
      members: allMemberRows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        teamIds:
          u.employeeProfiles[0]?.teamMemberships.map((m) => m.teamId) ?? [],
      })),
    },
  }
}

/** Drop empty / undefined arrays so the repo treats them as "no filter". */
function nonEmpty<T>(xs: T[] | undefined | null): T[] | undefined {
  if (!xs || xs.length === 0) return undefined
  return xs
}
