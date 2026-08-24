import { NextResponse } from "next/server"

import { handleApiRequest } from "@/lib/api-auth"
import type { ApiScope } from "@/lib/api-scopes"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"

/**
 * GET /api/v1/pending — everything in this org waiting on a human.
 *
 * ## Why this exists
 *
 * The reason an admin opens AltomateHR is usually not to do a specific
 * thing — it's to find out WHAT needs doing, which today means scanning
 * five screens. This collapses that into one call, so a chat client can
 * open with "here's what's waiting" instead of "what would you like to
 * know?".
 *
 * ## Counts, not contents
 *
 * Each section reports how much is waiting, not the items themselves.
 * That is deliberate: the caller drills into the one section the user
 * actually cares about via the existing list endpoints
 * (`GET /api/v1/claims?status=…`, etc). Dumping every pending row here
 * would make the common case — "anything need me?" — the most expensive
 * call in the API, and for an LLM caller it would burn the context that
 * the follow-up question needs.
 *
 * Payroll runs are the exception: they're few, they're the highest-stakes
 * item, and knowing WHICH period is waiting is the whole answer. Those
 * come back inline.
 *
 * ## Scopes: partial results rather than a blanket 403
 *
 * Declared with `[]` (valid token, no particular grant — same as
 * `whoami`) and each section is gated on the token's own scopes
 * instead. An aggregate endpoint that 403s because the token lacks ONE
 * of four scopes would be useless to every narrowly-scoped token, so a
 * section the caller can't see is omitted and named in `omitted` — the
 * caller can tell "nothing pending" from "you can't see this".
 */

type PendingSection = "claims" | "leave" | "attendance" | "payrollRuns"

const SECTION_SCOPE: Record<PendingSection, ApiScope> = {
  claims: "claims:read",
  leave: "leave:read",
  attendance: "attendance:read",
  payrollRuns: "payroll:read",
}

export const GET = handleApiRequest([], async (_request, ctx) => {
  const organizationId = ctx.integration.organizationId
  const held = new Set<string>(ctx.integration.scopes)
  const can = (section: PendingSection) => held.has(SECTION_SCOPE[section])

  const omitted: PendingSection[] = (
    Object.keys(SECTION_SCOPE) as PendingSection[]
  ).filter((s) => !can(s))

  const [claims, leave, attendance, payrollRuns] = await Promise.all([
    can("claims")
      ? claimRepository.countPendingForOrganization(organizationId)
      : Promise.resolve(null),
    can("leave")
      ? leaveRepository.countPendingForOrganization(organizationId)
      : Promise.resolve(null),
    can("attendance")
      ? countPendingAttendance(organizationId)
      : Promise.resolve(null),
    can("payrollRuns")
      ? payrollRunRepository.listForOrganization(organizationId)
      : Promise.resolve(null),
  ])

  const awaitingApproval = (payrollRuns ?? []).filter(
    (r) => r.status === "PENDING_APPROVAL",
  )

  const data = {
    ...(claims !== null ? { claims: { pending: claims } } : {}),
    ...(leave !== null ? { leave: { pending: leave } } : {}),
    ...(attendance !== null ? { attendance: { pending: attendance } } : {}),
    ...(payrollRuns !== null
      ? {
          payrollRuns: {
            pendingApproval: awaitingApproval.length,
            /// Inline because there are normally 0-1 and the period is
            /// the answer, not a lookup key.
            runs: awaitingApproval.map((r) => ({
              id: r.id,
              periodYear: r.periodYear,
              periodMonth: r.periodMonth,
              status: r.status,
              payslipCount: r.payslipCount,
            })),
          },
        }
      : {}),
  }

  // Single number for "does anything need me at all?" — the question
  // that gets asked most and deserves not to need arithmetic.
  const total =
    (claims ?? 0) + (leave ?? 0) + (attendance ?? 0) + awaitingApproval.length

  return NextResponse.json({
    data,
    total,
    ...(omitted.length > 0 ? { omitted } : {}),
  })
})

/**
 * Org-wide count of pending attendance/OT approvals.
 *
 * `countPendingApprovalsForEmployees` takes employee ids rather than an
 * org, so we resolve the org's members first. Deliberately reusing the
 * two existing methods instead of adding a third that would have to
 * re-derive the ApprovalRequest → employee → org join: this endpoint is
 * called occasionally, and a wrong join here would silently under-report
 * rather than fail.
 */
async function countPendingAttendance(organizationId: string): Promise<number> {
  const members =
    await organizationRepository.getOrganizationMembers(organizationId)
  const employeeIds = members
    .map((m) => m.employeeProfileId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
  if (employeeIds.length === 0) return 0
  return attendanceRepository.countPendingApprovalsForEmployees(employeeIds)
}
