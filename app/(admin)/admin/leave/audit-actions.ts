"use server"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import {
  listLeaveAuditLog,
  type LeaveAuditEntry,
  type LeaveAuditFilters,
} from "@/modules/leave/application/services/leave-overview.service"

export async function loadLeaveAuditLogAction(
  filters: LeaveAuditFilters,
): Promise<{ ok: true; rows: LeaveAuditEntry[] } | { ok: false; error: string }> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    return { ok: false, error: "Unauthorized" }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, error: "No active organization" }
  const rows = await listLeaveAuditLog(orgId, filters)
  return { ok: true, rows }
}
