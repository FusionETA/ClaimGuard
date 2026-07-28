import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { appraisalRepository } from "@/modules/appraisify/infrastructure/appraisal.repository"
import { resolvePhaseForUser } from "@/modules/appraisify/domain/models"

import { renderAppraisalReportPdf } from "./report-renderers/appraisal-report-pdf"

/** Filesystem-safe filename built from the reference number, e.g. "Appraisal-APR-2026-000042.pdf". */
function buildReportFileName(referenceNumber: string): string {
  return `Appraisal-${referenceNumber}.pdf`
}

async function renderReportBytes(
  record: NonNullable<Awaited<ReturnType<typeof appraisalRepository.getByIdForOrg>>>,
  orgId: string,
): Promise<{ bytes: Buffer; fileName: string }> {
  const org = await organizationRepository.getOrganizationById(orgId)
  const bytes = await renderAppraisalReportPdf({
    organizationName: org?.name ?? "",
    record,
    generatedAt: new Date(),
  })
  return { bytes, fileName: buildReportFileName(record.referenceNumber) }
}

/**
 * Generate the PDF report for a completed appraisal. Only a participant
 * (reviewee, reviewer, or partner) may download it, and only once the full
 * cycle has reached `SUBMITTED` — mirrors the gating already enforced by
 * `getAppraisalConfirmationData` plus the extra stage check the report needs.
 * Returns `null` on any auth/not-found/not-ready condition so the route can
 * respond with a plain 404 without leaking which case applied.
 */
export async function getAppraisalReportPdfBytes(
  appraisalId: string,
): Promise<{ bytes: Buffer; fileName: string } | null> {
  const session = await getCurrentSession()
  if (!session) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const record = await appraisalRepository.getByIdForOrg(appraisalId, orgId)
  if (!record) return null
  if (!resolvePhaseForUser(record, session.userId)) return null
  if (record.stage !== "SUBMITTED") return null

  return renderReportBytes(record, orgId)
}

/**
 * Admin variant: any org admin may download the report for any employee's
 * completed appraisal, not just participants. Org-scoping plus the
 * `/admin/:path*` middleware role gate is the only access control — see
 * `getAdminAppraisalDetailData` for the same reasoning on the detail page.
 */
export async function getAdminAppraisalReportPdfBytes(
  appraisalId: string,
): Promise<{ bytes: Buffer; fileName: string } | null> {
  const session = await getCurrentSession()
  if (!session) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null

  const record = await appraisalRepository.getByIdForOrg(appraisalId, orgId)
  if (!record) return null
  if (record.stage !== "SUBMITTED") return null

  return renderReportBytes(record, orgId)
}
