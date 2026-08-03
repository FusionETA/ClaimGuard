import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"
import type { DailyExportEmployee } from "@/modules/attendance/application/services/attendance-daily-export.service"

/**
 * Shared auth + query parsing for the two day-by-day attendance export
 * routes (PDF and Excel). They differ only in the renderer they call, so
 * everything up to "who and when" lives here.
 */
export type DailyExportRequest = {
  orgId: string
  from: Date
  to: Date
  employees: DailyExportEmployee[]
}

export async function resolveDailyExportRequest(
  url: URL,
): Promise<DailyExportRequest | { error: string; status: number }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { error: "Unauthorized.", status: 401 }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { error: "No active organization.", status: 400 }

  const fromStr = url.searchParams.get("from")
  const toStr = url.searchParams.get("to")
  if (!fromStr || !toStr) {
    return { error: "Missing required params: from, to", status: 400 }
  }
  const from = new Date(`${fromStr}T00:00:00Z`)
  const to = new Date(`${toStr}T23:59:59Z`)
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
    return { error: "Invalid date range.", status: 400 }
  }

  const idsParam = url.searchParams.get("employeeIds")
  const employeeIds = idsParam ? idsParam.split(",").filter(Boolean) : null

  // Resolve names/designations server-side rather than trusting the
  // query string, and re-apply the admin's policy scope so a hand-edited
  // id list can't pull in employees they can't see.
  const employees = await adminAttendanceService.getOrgHistoryEmployees({
    orgId,
    projectId: url.searchParams.get("projectId"),
    teamId: url.searchParams.get("teamId"),
    q: url.searchParams.get("q"),
    employeeIds,
    policyIdScope: await getActiveAdminPolicyScope(),
  })
  if (employees.length === 0) {
    return { error: "No employees match this selection.", status: 400 }
  }

  return { orgId, from, to, employees }
}
