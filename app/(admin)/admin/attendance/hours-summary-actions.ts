"use server"

import { requirePortalSession, resolveActiveOrgId } from "@/lib/auth/session"
import { adminAttendanceService } from "@/modules/attendance/application/services/admin-attendance.service"

function parseRange(fromIso: string, toIso: string): { from: Date; to: Date } {
  const from = new Date(fromIso)
  const to = new Date(toIso)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Invalid date range")
  }
  if (from > to) throw new Error("'from' date must be on or before 'to' date")
  return { from, to }
}

export async function loadOrgHoursSummaryAction(
  fromIso: string,
  toIso: string,
  projectId?: string | null,
) {
  const session = await requirePortalSession("ADMIN")
  const { from, to } = parseRange(fromIso, toIso)
  // resolveActiveOrgId honours the dropdown-selected company
  // (`activeOrganizationId`) and falls back to the admin's home org.
  // Using session.organizationId directly would lock this query to the
  // home org regardless of which company the admin selected — that was
  // the bug behind "audit log doesn't filter by selected company".
  return adminAttendanceService.getOrgHoursSummary(
    resolveActiveOrgId(session) ?? null,
    from,
    to,
    projectId ?? null,
  )
}

/**
 * Project-leading variant so the page can bind the projectId before
 * passing the action to a (from, to) → data panel.
 */
export async function loadOrgHoursSummaryForProjectAction(
  projectId: string | null,
  fromIso: string,
  toIso: string,
) {
  return loadOrgHoursSummaryAction(fromIso, toIso, projectId)
}

export async function loadApprovalAuditLogForProjectAction(
  projectId: string | null,
  fromIso: string,
  toIso: string,
) {
  return loadApprovalAuditLogAction(fromIso, toIso, projectId)
}

export async function loadEmployeeHoursSummaryAction(
  employeeId: string,
  fromIso: string,
  toIso: string,
) {
  await requirePortalSession("ADMIN")
  const { from, to } = parseRange(fromIso, toIso)
  return adminAttendanceService.getEmployeeHoursSummary(employeeId, from, to)
}

export async function loadApprovalAuditLogAction(
  fromIso: string,
  toIso: string,
  projectId?: string | null,
) {
  const session = await requirePortalSession("ADMIN")
  const { from, to } = parseRange(fromIso, toIso)
  // resolveActiveOrgId — see loadOrgHoursSummaryAction above for why this
  // matters. Without it, the audit log ignored the company-switcher.
  return adminAttendanceService.getApprovalAuditLog(
    resolveActiveOrgId(session) ?? null,
    from,
    to,
    projectId ?? null,
  )
}
