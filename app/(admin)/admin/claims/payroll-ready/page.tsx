import { redirect } from "next/navigation"
import { isAdminRole } from "@/lib/auth/types"

import { ClaimPayrollReadyList } from "@/components/admin/claim-payroll-ready-list"
import { Card, CardContent } from "@/components/ui/card"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { claimRepository } from "@/modules/claims/infrastructure/claim.repository"
import {
  getActiveAdminPolicyScope,
  hasAdminModule,
  requireAdminModule,
} from "@/modules/organization/application/services/admin-access.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { payrollRunRepository } from "@/modules/payroll/infrastructure/payroll-run.repository"

/**
 * /admin/claims/payroll-ready
 *
 * Replaces the previous "/admin/claims/sync" page. Lists every
 * REVIEWED + PERSONAL-paid claim that hasn't yet been attached to a
 * payroll run. From each row, the admin can pick a DRAFT run and
 * attach the claim — the claim then appears under that run's
 * Reimbursements card and disappears from this list.
 *
 * Xero sync has been removed from this surface. It used to be the
 * approval step BEFORE attaching to payroll; now it becomes a
 * post-submit, module-gated step (or skipped entirely for orgs that
 * don't use Xero). The previous `syncClaimAction` is still exported
 * for the future "Xero module" build, just not wired to any UI.
 */
export default async function AdminClaimsPayrollReadyPage() {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) redirect("/login")
  await requireAdminModule(["claims_personal", "claims_company"])

  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm text-muted-foreground">
            Pick or create an organization before submitting claims to
            payroll.
          </p>
        </CardContent>
      </Card>
    )
  }

  // Per-policy scope + per-claim-type module gate. PERSONAL claims are
  // visible to admins with the `claims_personal` module; COMPANY claims
  // to admins with `claims_company`. Owners / legacy admins see both.
  const [policyIdScope, canSeePersonal, canSeeCompany] = await Promise.all([
    getActiveAdminPolicyScope(),
    hasAdminModule("claims_personal"),
    hasAdminModule("claims_company"),
  ])
  const paymentTypes: Array<"PERSONAL" | "COMPANY"> = []
  if (canSeePersonal) paymentTypes.push("PERSONAL")
  if (canSeeCompany) paymentTypes.push("COMPANY")

  const [claims, allRuns, xeroConnectionId] = await Promise.all([
    claimRepository.getClaimsAwaitingSync(organizationId, undefined, {
      policyIdScope,
      paymentTypes,
    }),
    payrollRunRepository.listForOrganization(organizationId),
    organizationRepository.getActiveXeroConnectionId(organizationId),
  ])

  // Only DRAFT runs can have claims attached — submitted runs are
  // locked. We surface the list (newest-first) so the picker can let
  // the admin choose which run to attach to.
  const draftRuns = allRuns.filter((r) => r.status === "DRAFT")

  // When the org isn't connected to Xero, the bill / spend-money bulk
  // actions are hidden — the only available action is "add to payroll".
  const xeroConnected = Boolean(xeroConnectionId)

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          Reviewed claims awaiting payment. Personal-money claims can be
          added to a payroll run (paid via payroll) or
          {xeroConnected ? " synced to Xero as a bill" : " — connect Xero to also bill them"}.
          {xeroConnected
            ? " Company-money claims post to Xero as Spend Money."
            : ""}
        </p>
      </div>

      <ClaimPayrollReadyList
        claims={claims}
        draftRuns={draftRuns}
        xeroConnected={xeroConnected}
      />
    </div>
  )
}
