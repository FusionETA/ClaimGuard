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
  teamId?: string | null,
  q?: string | null,
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
    teamId ?? null,
    q ?? null,
  )
}

/**
 * Filter-leading variants so the page can bind project/team/search
 * before passing the action to a (from, to) → data panel.
 */
export async function loadOrgHoursSummaryForFiltersAction(
  filters: { projectId: string | null; teamId: string | null; q: string | null },
  fromIso: string,
  toIso: string,
) {
  return loadOrgHoursSummaryAction(
    fromIso,
    toIso,
    filters.projectId,
    filters.teamId,
    filters.q,
  )
}

export async function loadApprovalAuditLogForFiltersAction(
  filters: { projectId: string | null; teamId: string | null; q: string | null },
  fromIso: string,
  toIso: string,
) {
  return loadApprovalAuditLogAction(
    fromIso,
    toIso,
    filters.projectId,
    filters.teamId,
    filters.q,
    ["APPROVED"],
  )
}

export async function loadPendingRejectedAuditLogForFiltersAction(
  filters: { projectId: string | null; teamId: string | null; q: string | null },
  fromIso: string,
  toIso: string,
) {
  return loadApprovalAuditLogAction(
    fromIso,
    toIso,
    filters.projectId,
    filters.teamId,
    filters.q,
    ["PENDING", "REJECTED"],
  )
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
  teamId?: string | null,
  q?: string | null,
  statuses?: Array<"APPROVED" | "REJECTED" | "PENDING">,
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
    teamId ?? null,
    q ?? null,
    statuses,
  )
}
