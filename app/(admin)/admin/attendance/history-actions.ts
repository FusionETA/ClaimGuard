"use server"

import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"

/**
 * A bad range is user input, not a bug — a half-typed date in the From
 * field is enough to produce one. Return it so the panel can toast the
 * message; throwing here surfaced as an unhandled server error page.
 */
function parseRange(
  fromIso: string,
  toIso: string,
): { from: Date; to: Date } | { error: string } {
  const from = new Date(fromIso)
  const to = new Date(toIso)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: "Enter a valid date range." }
  }
  if (from > to) {
    return { error: "'From' date must be on or before the 'To' date." }
  }
  return { from, to }
}

/**
 * Employees covered by the History tab's project/team/search filter —
 * the export scope. The panel refreshes this whenever those filters
 * change so the export dialog offers the right people. Status pills are
 * intentionally not passed: the export lists everyone in the selected
 * project/team, marking absences rather than dropping them.
 */
export async function loadOrgHistoryEmployeesAction(
  projectId: string | null,
  teamId: string | null,
  q: string | null,
) {
  const session = await requirePortalSession("ADMIN")
  const policyIdScope = await getActiveAdminPolicyScope()
  return adminAttendanceService.getOrgHistoryEmployees({
    orgId: resolveActiveOrgId(session) ?? null,
    projectId,
    teamId,
    q,
    policyIdScope,
  })
}

export async function loadOrgHistoryAction(
  fromIso: string,
  toIso: string,
  projectId: string | null,
  teamId: string | null,
  q: string | null,
  statuses: string[],
  page: number,
) {
  const session = await requirePortalSession("ADMIN")
  const range = parseRange(fromIso, toIso)
  if ("error" in range) return { rows: [], total: 0, error: range.error }
  const { from, to } = range
  const policyIdScope = await getActiveAdminPolicyScope()
  return adminAttendanceService.getOrgHistory({
    orgId: resolveActiveOrgId(session) ?? null,
    from,
    to,
    projectId,
    teamId,
    q,
    statuses: statuses.length > 0 ? statuses : undefined,
    page,
    policyIdScope,
  })
}
