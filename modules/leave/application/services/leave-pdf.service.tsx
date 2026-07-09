import "server-only"

import { renderToBuffer } from "@react-pdf/renderer"

import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import { listAllEmployeeBalancesForOrg } from "@/modules/leave/application/services/leave-entitlements.service"
import {
  LeaveSummaryDocument,
  LeaveSummaryBulkDocument,
  type LeaveMonthlyRow,
  type LeaveDetailRow,
  type LeaveSummaryDocumentProps,
} from "@/modules/leave/application/services/report-renderers/leave-summary-pdf"

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

function fmtNow(): string {
  return new Date().toLocaleString("en-MY", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  })
}

// ─── Core data builder — takes employee profile ID ─────────────────────────

async function buildEmployeeSection(
  profileId: string,
  employeeName: string,
  orgName: string,
  year: number,
  reportDate: string,
): Promise<LeaveSummaryDocumentProps> {
  const [entitlements, allApplications] = await Promise.all([
    leaveRepository.listEntitlementsForEmployee(profileId, year),
    leaveRepository.listApplicationsForEmployee(profileId),
  ])

  const approvedApps = allApplications.filter(
    (a) => a.status === "APPROVED" && new Date(a.startDate).getUTCFullYear() === year,
  )

  const usageMap = new Map<string, number[]>()
  for (const app of approvedApps) {
    const month = new Date(app.startDate).getUTCMonth()
    if (!usageMap.has(app.leaveTypeId)) {
      usageMap.set(app.leaveTypeId, new Array(12).fill(0))
    }
    usageMap.get(app.leaveTypeId)![month] += app.totalDays
  }

  const monthlyRows: LeaveMonthlyRow[] = entitlements.map((ent) => {
    const monthly = usageMap.get(ent.leaveTypeId) ?? new Array(12).fill(0)
    const total = monthly.reduce((s, v) => s + v, 0)
    const balance = ent.entitledDays + ent.carriedDays - total
    return {
      leaveTypeName: ent.leaveTypeName,
      entitledDays: ent.entitledDays,
      carriedDays: ent.carriedDays,
      monthly: monthly.map((v) => (v === 0 ? null : v)),
      total,
      balance,
    }
  })

  const detailRows: LeaveDetailRow[] = approvedApps
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())
    .map((app) => ({
      from: fmtDate(new Date(app.startDate)),
      to: fmtDate(new Date(app.endDate)),
      leaveTypeName: app.leaveTypeName,
      days: app.totalDays,
      reason: app.reason,
      attachmentName: app.attachmentName,
    }))

  return { organizationName: orgName, employeeName, year, reportDate, monthlyRows, detailRows }
}

// ─── Public API ────────────────────────────────────────────────────────────
// Both functions accept userId (User.id). listAllEmployeeBalancesForOrg
// provides the mapping userId → employeeProfileId used by the leave repo.

export async function generateLeaveSummaryPdf(
  orgId: string,
  userId: string,
  year: number,
): Promise<Buffer> {
  const [org, employeeList] = await Promise.all([
    organizationRepository.getOrganizationById(orgId),
    listAllEmployeeBalancesForOrg(orgId, year),
  ])

  const orgName = org?.name ?? "Organization"
  const emp = employeeList.find((e) => e.userId === userId)
  if (!emp) throw new Error("Employee not found in this organization.")

  const reportDate = fmtNow()
  const section = await buildEmployeeSection(
    emp.employeeProfileId, emp.name, orgName, year, reportDate,
  )
  return renderToBuffer(<LeaveSummaryDocument {...section} />)
}

export async function generateLeaveSummaryPdfBulk(
  orgId: string,
  year: number,
  userIds?: string[],
): Promise<Buffer> {
  const [org, employeeList] = await Promise.all([
    organizationRepository.getOrganizationById(orgId),
    listAllEmployeeBalancesForOrg(orgId, year),
  ])

  const filtered = userIds?.length
    ? employeeList.filter((e) => userIds.includes(e.userId))
    : employeeList

  if (filtered.length === 0) throw new Error("No employees found.")

  const orgName = org?.name ?? "Organization"
  const reportDate = fmtNow()

  const sections = await Promise.all(
    filtered.map((emp) =>
      buildEmployeeSection(emp.employeeProfileId, emp.name, orgName, year, reportDate),
    ),
  )
  return renderToBuffer(<LeaveSummaryBulkDocument sections={sections} />)
}
