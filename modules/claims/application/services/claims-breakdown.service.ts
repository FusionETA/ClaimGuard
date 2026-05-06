import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"

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
  if (!session || session.role !== "ADMIN") return null
  return resolveActiveOrgId(session) ?? null
}

export async function getProjectsBreakdown(monthKey?: string | null) {
  const organizationId = await requireAdminOrgId()
  if (!organizationId) return null

  const { monthKey: resolvedKey, monthStart, monthEnd } = resolveMonthBounds(monthKey)

  const projects = await claimRepository.getProjectsClaimBreakdown({
    organizationId,
    monthStart,
    monthEnd,
  })

  return { monthKey: resolvedKey, projects }
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

  const teams = await claimRepository.getTeamsClaimBreakdown({
    organizationId,
    projectId: input.projectId,
    monthStart,
    monthEnd,
  })

  return { monthKey: resolvedKey, teams }
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

  const members = await claimRepository.getMembersClaimBreakdown({
    organizationId,
    projectId: input.projectId,
    teamId: input.teamId,
    monthStart,
    monthEnd,
  })

  return { monthKey: resolvedKey, members }
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

  const claims = await claimRepository.getMemberClaimsForBreakdown({
    organizationId,
    projectId: input.projectId,
    employeeId: input.employeeId,
    monthStart,
    monthEnd,
  })

  return { monthKey: resolvedKey, claims }
}
