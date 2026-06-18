"use server"

import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"

function parseRange(fromIso: string, toIso: string): { from: Date; to: Date } {
  const from = new Date(fromIso)
  const to = new Date(toIso)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Invalid date range")
  }
  if (from > to) throw new Error("'from' must be on or before 'to'")
  return { from, to }
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
  const { from, to } = parseRange(fromIso, toIso)
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
