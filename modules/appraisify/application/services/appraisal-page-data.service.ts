import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { appraisalRepository } from "@/modules/appraisify/infrastructure/appraisal.repository"
import { appraisalTemplateRepository } from "@/modules/appraisify/infrastructure/appraisal-template.repository"
import {
  buildCycleLabel,
  phaseAccessFor,
  resolvePhaseForUser,
  scoreSummary,
  toAppraisalListItem,
  type AdminAppraisalDashboardData,
  type AdminAppraisalHistoryRow,
  type AdminEmployeeRow,
  type AppraisalFormData,
  type AppraisalRecord,
  type EmployeeAppraisalDashboardData,
} from "@/modules/appraisify/domain/models"

/** The overall submitted-at for an appraisal (latest completed phase). */
function lastSubmittedAt(r: AppraisalRecord): string | null {
  return r.partnerSubmittedAt ?? r.reviewerSubmittedAt ?? r.revieweeSubmittedAt ?? null
}

/**
 * Employee dashboard bag: the viewer's own current cycle (where they are the
 * reviewee) plus their full participation history (as reviewee/reviewer/partner).
 */
export async function getEmployeeAppraisalDashboardData(): Promise<EmployeeAppraisalDashboardData | null> {
  const session = await getCurrentSession()
  if (!session) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const records = await appraisalRepository.listForUser(session.userId, orgId)

  // "My Appraisal" = the most recent cycle where the viewer is the reviewee.
  const ownRecord = records.find((r) => r.reviewee.id === session.userId) ?? null

  return {
    viewer: { id: session.userId, name: session.name, initials: session.initials },
    current: ownRecord
      ? {
          item: toAppraisalListItem(ownRecord, session.userId),
          role: ownRecord.role,
          team: ownRecord.team,
          scores: scoreSummary(ownRecord.questions),
        }
      : null,
    history: records.map((r) => toAppraisalListItem(r, session.userId)),
  }
}

/**
 * Form-page bag: the record, the phase the viewer plays, and the gating
 * decision. Returns null when the viewer isn't a participant or the record
 * doesn't exist / belong to the active org.
 */
export async function getAppraisalFormData(
  appraisalId: string,
): Promise<AppraisalFormData | null> {
  const session = await getCurrentSession()
  if (!session) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const record = await appraisalRepository.getByIdForOrg(appraisalId, orgId)
  if (!record) return null

  const phase = resolvePhaseForUser(record, session.userId)
  if (!phase) return null

  return { record, phase, access: phaseAccessFor(record.stage, phase) }
}

/** Confirmation-page data (just the reference number, scoped + guarded). */
export async function getAppraisalConfirmationData(
  appraisalId: string,
): Promise<{ referenceNumber: string } | null> {
  const session = await getCurrentSession()
  if (!session) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const record = await appraisalRepository.getByIdForOrg(appraisalId, orgId)
  if (!record) return null
  if (!resolvePhaseForUser(record, session.userId)) return null

  return { referenceNumber: record.referenceNumber }
}

/** Admin dashboard bag: stats, employees, history, reviewer/partner options. */
export async function getAdminAppraisalDashboardData(): Promise<AdminAppraisalDashboardData | null> {
  const session = await getCurrentSession()
  if (!session) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const [records, employees, people, templates] = await Promise.all([
    appraisalRepository.listForOrg(orgId),
    appraisalRepository.listOrgEmployees(orgId),
    appraisalRepository.listOrgPeople(orgId),
    appraisalTemplateRepository.listForOrg(orgId),
  ])

  // Active (non-SUBMITTED) appraisal stage per reviewee.
  const activeByReviewee = new Map<string, AppraisalRecord>()
  for (const r of records) {
    if (r.stage !== "SUBMITTED" && !activeByReviewee.has(r.reviewee.id)) {
      activeByReviewee.set(r.reviewee.id, r)
    }
  }

  const employeeRows: AdminEmployeeRow[] = employees.map((e) => {
    const active = activeByReviewee.get(e.userId) ?? null
    return {
      id: e.userId,
      name: e.name,
      initials: e.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0]!.toUpperCase())
        .join(""),
      position: e.jobTitle,
      department: "",
      activeStage: active ? active.stage : null,
    }
  })

  const history: AdminAppraisalHistoryRow[] = records.map((r) => ({
    id: r.id,
    employeeName: r.reviewee.name,
    cycleLabel: buildCycleLabel(r.type, r.year),
    stage: r.stage,
    submittedAt: lastSubmittedAt(r),
  }))

  return {
    stats: {
      active: records.filter((r) => r.stage !== "SUBMITTED").length,
      complete: records.filter((r) => r.stage === "SUBMITTED").length,
    },
    employees: employeeRows,
    history,
    people,
    templates,
  }
}
