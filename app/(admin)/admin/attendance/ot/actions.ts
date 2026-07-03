"use server"

import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

export type OtSubmissionRow = Awaited<
  ReturnType<typeof adminAttendanceService.getOtSubmissionsForOrg>
>[number]

export async function loadOtSubmissionsAction(
  fromIso: string,
  toIso: string,
  statuses: Array<"PENDING" | "APPROVED" | "REJECTED">,
): Promise<OtSubmissionRow[]> {
  const session = await requirePortalSession("ADMIN")
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return []
  return adminAttendanceService.getOtSubmissionsForOrg({
    orgId,
    from: new Date(fromIso),
    to: new Date(toIso),
    statuses: statuses.length > 0 ? statuses : undefined,
  })
}
