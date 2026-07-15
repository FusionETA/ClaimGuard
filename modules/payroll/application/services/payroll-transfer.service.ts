import "server-only"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import {
  bustAttendanceCaches,
  bustClaimCaches,
  bustLeaveCaches,
  bustOrgConfigCaches,
  bustPayrollCaches,
} from "@/lib/cache-invalidation"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
// Reach for the Prisma client via the infrastructure re-export the same
// way payroll-profile.service.ts does — the repo-wide ESLint rule
// forbids importing `@/lib/prisma` from any file outside
// `modules/<m>/infrastructure/**`. The transfer flow needs a live
// prisma handle for its cross-aggregate transaction (archive source +
// create target profile + create payroll + membership atomically), so
// borrowing the payroll-run repo's typed accessor keeps the lint rule
// happy without pulling every micro-query into its own repo method.
import { employmentStintRepository } from "@/modules/payroll/infrastructure/employment-stint.repository"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { payrollTransferRepository } from "@/modules/payroll/infrastructure/payroll-transfer.repository"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"
import type {
  EmployeeTransferRow,
  PendingTransferRow,
} from "@/modules/payroll/infrastructure/payroll-transfer.repository"

/**
 * Employee-transfer service. Backs the "Transfer" wizard on the
 * employee detail page (alongside "Archive") and the daily cron that
 * executes queued transfers on their effective date.
 *
 * Ownership + auth: the admin must have an active AdminOrganization
 * link on BOTH the source org (where they clicked the button) and the
 * target org (from the picker). Owners automatically pass because they
 * have AdminOrganization links to every org they own.
 *
 * Semantics: on execute, the source PayrollProfile is archived
 * (leaveDate = effectiveDate − 1 day, isArchived = true), and a new
 * EmployeeProfile + PayrollProfile + EmployeeOrganization are created
 * at the target org. Leave entitlements start fresh at target — the
 * target company's policy accruals fire from the effective date. YTD
 * PCB / EPF / bonus etc. get written to the target's prevEmployment
 * fields (only when copyPayrollInfo = true) so LHDN MTD stays
 * accurate across the same-Owner move.
 *
 * NEVER copied: teams, hierarchy, project assignments, attendance
 * history, claim history, existing loans. The employee is a fresh hire
 * at the target for those purposes.
 */

// ─── Public types ──────────────────────────────────────────────────

export type CreateTransferInput = {
  sourceEmployeeProfileId: string
  targetOrganizationId: string
  targetPolicyId: string
  effectiveDate: string // ISO yyyy-mm-dd
  copyPayrollInfo: boolean
  notes: string | null
}

export type CreateTransferResult = {
  transfer: EmployeeTransferRow
  /// True when effectiveDate = today and the service executed the
  /// transfer inline. False when it was queued for a future date.
  executedImmediately: boolean
}

export type AvailableTargetOrg = {
  id: string
  name: string
  policies: Array<{ id: string; name: string; isDefault: boolean }>
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Return the list of orgs the current admin can transfer TO from the
 * given source org. Filters out the source itself and any org the
 * admin doesn't have an AdminOrganization link on. Each row includes
 * the target's active policies so the wizard can populate the picker
 * without a second round trip.
 */
export async function listTransferTargetsForAdmin(input: {
  sourceOrganizationId: string
}): Promise<AvailableTargetOrg[]> {
  const session = await requireAdminSession()
  const prisma = getPrismaClient()
  if (!prisma) return []

  // Every org this admin can access (AdminOrganization links + legacy
  // primary org). `getAdminOrganizations` already handles the union.
  const scoped = await organizationRepository.getAdminOrganizations(
    session.userId,
  )

  // Fetch policies in bulk so we don't fan out N queries — Prisma
  // groups them via a single findMany with an `in` clause.
  const orgIds = scoped
    .map((o) => o.id)
    .filter((id) => id !== input.sourceOrganizationId)
  if (orgIds.length === 0) return []

  const policies = await prisma.employeePolicy.findMany({
    where: {
      organizationId: { in: orgIds },
      archivedAt: null,
    },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: {
      id: true,
      organizationId: true,
      name: true,
      isDefault: true,
    },
  })
  const policiesByOrg = new Map<string, AvailableTargetOrg["policies"]>()
  for (const p of policies) {
    const list = policiesByOrg.get(p.organizationId) ?? []
    list.push({ id: p.id, name: p.name, isDefault: p.isDefault })
    policiesByOrg.set(p.organizationId, list)
  }

  const out: AvailableTargetOrg[] = []
  for (const s of scoped) {
    if (s.id === input.sourceOrganizationId) continue
    const policyList = policiesByOrg.get(s.id) ?? []
    // Skip orgs with no active policies — the admin can't finish the
    // wizard without one, and showing a dead-end option is worse than
    // hiding it.
    if (policyList.length === 0) continue
    out.push({
      id: s.id,
      name: s.name,
      policies: policyList,
    })
  }
  return out
}

/**
 * Schedule (or immediately execute) a transfer. Validates every
 * precondition before touching any data:
 *
 *   - Admin has access to source + target orgs
 *   - Source employee exists in source org and isn't archived
 *   - Target policy belongs to target org
 *   - User isn't already active at target org
 *   - No existing PENDING transfer for this employee
 *   - Effective date isn't in the past
 *
 * If effectiveDate is today, the transfer executes inline before
 * returning. Otherwise it sits at PENDING for the cron to pick up.
 */
export async function createEmployeeTransfer(
  input: CreateTransferInput,
): Promise<CreateTransferResult> {
  const session = await requireAdminSession()
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  const effectiveDate = parseISODate(input.effectiveDate)
  if (!effectiveDate) {
    throw new Error("Effective date is invalid.")
  }
  const today = startOfDayUtc(new Date())
  if (effectiveDate < today) {
    throw new Error("Effective date can't be in the past.")
  }

  // Load source profile + user + source org id in one hit
  const source = await prisma.employeeProfile.findUnique({
    where: { id: input.sourceEmployeeProfileId },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      payrollProfile: {
        select: { isArchived: true },
      },
      user: { select: { name: true, email: true } },
    },
  })
  if (!source || !source.organizationId) {
    throw new Error("Employee not found.")
  }
  if (source.payrollProfile?.isArchived === true) {
    throw new Error(
      "Employee is already archived — restore before transferring.",
    )
  }
  if (source.organizationId === input.targetOrganizationId) {
    throw new Error("Source and target companies must differ.")
  }

  // Admin access: must have BOTH source and target as accessible orgs.
  const accessible = new Set(
    (
      await organizationRepository.getAdminOrganizations(session.userId)
    ).map((o) => o.id),
  )
  if (!accessible.has(source.organizationId)) {
    throw new Error("You don't have access to the source company.")
  }
  if (!accessible.has(input.targetOrganizationId)) {
    throw new Error(
      "You don't have access to the target company. Ask the Owner to elevate your access first, or have the Owner run the transfer.",
    )
  }

  // Target policy has to actually belong to target org
  const targetPolicy = await prisma.employeePolicy.findFirst({
    where: {
      id: input.targetPolicyId,
      organizationId: input.targetOrganizationId,
      archivedAt: null,
    },
    select: { id: true },
  })
  if (!targetPolicy) {
    throw new Error("Target policy not found in the target company.")
  }

  // Refuse if the user already has an active profile at the target
  const existingAtTarget = await prisma.employeeProfile.findFirst({
    where: {
      userId: source.userId,
      organizationId: input.targetOrganizationId,
      OR: [
        { payrollProfile: null },
        { payrollProfile: { isArchived: false } },
      ],
    },
    select: { id: true },
  })
  if (existingAtTarget) {
    throw new Error(
      "This employee already has an active profile at the target company.",
    )
  }

  // At most one PENDING per source
  const alreadyPending =
    await payrollTransferRepository.findPendingBySource(source.id)
  if (alreadyPending) {
    throw new Error(
      "This employee already has a pending transfer. Cancel it first before scheduling another.",
    )
  }

  // Persist the row
  const transfer = await payrollTransferRepository.create({
    sourceEmployeeProfileId: source.id,
    sourceOrganizationId: source.organizationId,
    targetOrganizationId: input.targetOrganizationId,
    targetPolicyId: input.targetPolicyId,
    createdByUserId: session.userId,
    effectiveDate,
    copyPayrollInfo: input.copyPayrollInfo,
    notes: input.notes,
  })

  void writeAudit({
    organizationId: source.organizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "employee.transfer.scheduled",
    status: "SUCCESS",
    summary: `Scheduled transfer of ${source.user?.name ?? source.user?.email ?? source.id} to another company (effective ${input.effectiveDate})`,
    targetType: "employee_profile",
    targetId: source.id,
    metadata: {
      transferId: transfer.id,
      targetOrganizationId: input.targetOrganizationId,
      effectiveDate: input.effectiveDate,
      copyPayrollInfo: input.copyPayrollInfo,
    },
  })

  // Execute inline when the effective date is today so the admin sees
  // the change land immediately instead of "will move at midnight".
  if (effectiveDate.getTime() === today.getTime()) {
    await executeEmployeeTransfer({ transferId: transfer.id })
    const refreshed = await payrollTransferRepository.getById(transfer.id)
    return {
      transfer: refreshed ?? transfer,
      executedImmediately: true,
    }
  }

  return { transfer, executedImmediately: false }
}

/**
 * Cancel a PENDING transfer. Idempotent — cancelling an already
 * cancelled / executed / failed row is a no-op.
 */
export async function cancelEmployeeTransfer(input: {
  transferId: string
}): Promise<void> {
  const session = await requireAdminSession()
  const transfer = await payrollTransferRepository.getById(input.transferId)
  if (!transfer) throw new Error("Transfer not found.")
  if (transfer.status !== "PENDING") {
    // Silent no-op — nothing to cancel.
    return
  }

  const accessible = new Set(
    (
      await organizationRepository.getAdminOrganizations(session.userId)
    ).map((o) => o.id),
  )
  if (!accessible.has(transfer.sourceOrganizationId)) {
    throw new Error("You don't have access to the source company.")
  }

  await payrollTransferRepository.cancel(transfer.id)
  void writeAudit({
    organizationId: transfer.sourceOrganizationId,
    actor: {
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
    },
    action: "employee.transfer.cancelled",
    status: "SUCCESS",
    summary: `Cancelled pending transfer ${transfer.id}`,
    targetType: "employee_profile",
    targetId: transfer.sourceEmployeeProfileId,
    metadata: { transferId: transfer.id },
  })
}

/**
 * List every PENDING transfer whose source is in the given org. Used
 * by the Manage Employee page to render a "pending transfer" badge
 * next to affected employees.
 */
export async function listPendingTransfersForOrg(input: {
  organizationId: string
}): Promise<PendingTransferRow[]> {
  return payrollTransferRepository.listPendingForOrg(input.organizationId)
}

/**
 * Return the single PENDING transfer for this employee, if any. Used
 * by the employee detail page to render the "already scheduled"
 * banner + cancel button in place of the transfer wizard.
 */
export async function findPendingTransferForEmployee(input: {
  sourceEmployeeProfileId: string
}): Promise<EmployeeTransferRow | null> {
  return payrollTransferRepository.findPendingBySource(
    input.sourceEmployeeProfileId,
  )
}

/**
 * Execute a single transfer. Callable directly (when effectiveDate =
 * today the create flow inlines this) or by the daily cron.
 */
export async function executeEmployeeTransfer(input: {
  transferId: string
}): Promise<void> {
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  const transfer = await payrollTransferRepository.getById(input.transferId)
  if (!transfer) throw new Error("Transfer not found.")
  if (transfer.status === "EXECUTED") return
  if (transfer.status === "CANCELLED") {
    throw new Error("Transfer was cancelled and cannot be executed.")
  }

  const effectiveDate = parseISODate(transfer.effectiveDate)
  if (!effectiveDate) {
    throw new Error("Transfer effective date is invalid.")
  }
  const lastDayAtSource = new Date(effectiveDate)
  lastDayAtSource.setUTCDate(lastDayAtSource.getUTCDate() - 1)

  // Load source aggregate: profile + payroll profile + user + target org name
  const [source, targetOrg] = await Promise.all([
    prisma.employeeProfile.findUnique({
      where: { id: transfer.sourceEmployeeProfileId },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
        payrollProfile: true,
      },
    }),
    prisma.organization.findUnique({
      where: { id: transfer.targetOrganizationId },
      select: { id: true, name: true },
    }),
  ])
  if (!source || !source.organizationId) {
    throw new Error("Source employee no longer exists.")
  }
  if (!targetOrg) {
    throw new Error("Target company no longer exists.")
  }
  const sourceOrg = await prisma.organization.findUnique({
    where: { id: source.organizationId },
    select: { name: true },
  })
  const sourceOrgName = sourceOrg?.name ?? "previous company"

  // Guard against a race — someone else may have created an active
  // profile at the target between scheduling and execution.
  const existingAtTarget = await prisma.employeeProfile.findFirst({
    where: {
      userId: source.userId,
      organizationId: transfer.targetOrganizationId,
      OR: [
        { payrollProfile: null },
        { payrollProfile: { isArchived: false } },
      ],
    },
    select: { id: true },
  })
  if (existingAtTarget) {
    throw new Error(
      "Employee already has an active profile at the target company — cancel this transfer.",
    )
  }

  // Compute YTD BEFORE mutating anything — used to populate the
  // target profile's prevEmployment fields when copyPayrollInfo is on.
  const year = effectiveDate.getUTCFullYear()
  const ytd = transfer.copyPayrollInfo
    ? await payslipRepository.getYtdForEmployee({
        employeeProfileId: source.id,
        year,
      })
    : null

  await prisma.$transaction(async (tx) => {
    // 1a) Archive source PayrollProfile. Same fields the Archive
    //     button uses so the auto-archive cron doesn't fight us.
    if (source.payrollProfile) {
      await tx.payrollProfile.update({
        where: { id: source.payrollProfile.id },
        data: {
          leaveDate: lastDayAtSource,
          isArchived: true,
          archivedAt: new Date(),
          archiveReason: `Transferred to ${targetOrg.name} on ${transfer.effectiveDate}`,
        },
      })
    }
    // 1b) Close the source EmploymentStint. No-op for legacy profiles
    //     that haven't been backfilled yet — the archive above still
    //     hides them from the employee list, so the source side is
    //     safe either way.
    await employmentStintRepository.closeOpenStint(
      {
        employeeProfileId: source.id,
        leaveDate: lastDayAtSource,
        endReason: `Transferred to ${targetOrg.name}`,
        closedByTransferId: transfer.id,
      },
      tx,
    )

    // 2) Reuse OR create at target. Reuse when the employee already
    //    has an EmployeeProfile at the target org (round-trip
    //    scenario: A → C → A). This is the whole point of the stint
    //    model — no duplicate EmployeeProfile at Com A on return.
    //    The pre-execute guard above (`existingAtTarget`) has already
    //    refused the case where the reusable profile is currently
    //    active; anything found here is archived.
    const reusable = await tx.employeeProfile.findFirst({
      where: {
        userId: source.userId,
        organizationId: transfer.targetOrganizationId,
      },
      include: { payrollProfile: true },
    })

    const src = source.payrollProfile

    /** Payroll-side fields copied from the source PayrollProfile when
     * `copyPayrollInfo = true`. Extracted so both the reuse and
     * fresh-create branches produce identical target state. */
    const payrollFieldsFromSource = src
      ? {
          phone: src.phone,
          alternateEmail: src.alternateEmail,
          gender: src.gender,
          dateOfBirth: src.dateOfBirth,
          nationality: src.nationality,
          race: src.race,
          hasPr: src.hasPr,
          idType: src.idType,
          idNumber: src.idNumber,
          maritalStatus: src.maritalStatus,
          isResident: src.isResident,
          isOku: src.isOku,
          spouseWorking: src.spouseWorking,
          spouseDisabled: src.spouseDisabled,
          spousePcbNumber: src.spousePcbNumber,
          spouseIdNumber: src.spouseIdNumber,
          addressLine1: src.addressLine1,
          addressLine2: src.addressLine2,
          addressLine3: src.addressLine3,
          city: src.city,
          postcode: src.postcode,
          state: src.state,
          emergencyContactName: src.emergencyContactName,
          emergencyContactPhone: src.emergencyContactPhone,
          emergencyContactRelation: src.emergencyContactRelation,
          childRelief: src.childRelief ?? undefined,
          contributeToEpf: transfer.copyPayrollInfo
            ? src.contributeToEpf
            : true,
          epfMemberBefore1998: transfer.copyPayrollInfo
            ? src.epfMemberBefore1998
            : false,
          epfNumber: transfer.copyPayrollInfo ? src.epfNumber : null,
          epfEmployeeRate: transfer.copyPayrollInfo
            ? src.epfEmployeeRate
            : undefined,
          epfEmployeeVoluntary: transfer.copyPayrollInfo
            ? src.epfEmployeeVoluntary
            : undefined,
          epfEmployerVoluntary: transfer.copyPayrollInfo
            ? src.epfEmployerVoluntary
            : undefined,
          socsoNumber: transfer.copyPayrollInfo ? src.socsoNumber : null,
          socsoScheme: transfer.copyPayrollInfo ? src.socsoScheme : null,
          contributeToEis: transfer.copyPayrollInfo
            ? src.contributeToEis
            : true,
          // SKBBK opt-in follows the same "copy vs reset" rule as EIS.
          // Reset default is FALSE (matches the schema default and the
          // "admin explicitly opts each employee in" model).
          contributeToSkbbk: transfer.copyPayrollInfo
            ? src.contributeToSkbbk
            : false,
          incomeTaxNumber: transfer.copyPayrollInfo
            ? src.incomeTaxNumber
            : null,
          pcbBorneByEmployer: transfer.copyPayrollInfo
            ? src.pcbBorneByEmployer
            : false,
          ssfwNumber: transfer.copyPayrollInfo ? src.ssfwNumber : null,
          paymentMethod: transfer.copyPayrollInfo
            ? src.paymentMethod
            : undefined,
          bankName: transfer.copyPayrollInfo ? src.bankName : null,
          bankAccountHolderName: transfer.copyPayrollInfo
            ? src.bankAccountHolderName
            : null,
          bankAccountNumber: transfer.copyPayrollInfo
            ? src.bankAccountNumber
            : null,
          salaryType: src.salaryType,
          monthlySalary: transfer.copyPayrollInfo ? src.monthlySalary : null,
          hourlyRate: transfer.copyPayrollInfo ? src.hourlyRate : null,
          fixedAllowances: transfer.copyPayrollInfo
            ? src.fixedAllowances ?? undefined
            : undefined,
          prevEmploymentYear: ytd ? year : null,
          prevRemuneration: ytd ? ytd.ytdTaxable : null,
          prevEpf: ytd ? ytd.ytdEpf : null,
          joinDate: effectiveDate,
          // Explicit re-open of the target profile — clear any
          // stale archive markers left by a previous outbound
          // transfer. Safe to set on a create too (defaults).
          leaveDate: null,
          isArchived: false,
          archivedAt: null,
          archiveReason: null,
        }
      : {
          // No source PayrollProfile (rare — an employee without a
          // payroll profile shouldn't be transferable, but stay
          // defensive). Bare-minimum target so the fresh create
          // path doesn't blow up.
          payrollDocuments: [],
          salaryType: "MONTHLY" as const,
          joinDate: effectiveDate,
          leaveDate: null,
          isArchived: false,
          archivedAt: null,
          archiveReason: null,
        }

    let targetProfileId: string

    if (reusable) {
      // ─── REUSE PATH ─────────────────────────────────────────────
      // Employee is returning to a company where they previously
      // worked. Unarchive the existing EmployeeProfile + PayrollProfile
      // and update fields to reflect the incoming state. No new
      // EmployeeProfile, no employee code drift, no duplicate rows.
      targetProfileId = reusable.id

      await tx.employeeProfile.update({
        where: { id: reusable.id },
        data: {
          jobTitle: source.jobTitle,
          policyId: transfer.targetPolicyId,
          preferredCurrency: source.preferredCurrency,
        },
      })

      if (reusable.payrollProfile) {
        await tx.payrollProfile.update({
          where: { id: reusable.payrollProfile.id },
          data: payrollFieldsFromSource,
        })
      } else {
        // Reusable EmployeeProfile without a PayrollProfile — rare
        // (an unfinished onboarding at the target org) but we need
        // to seed one now so payroll can run there.
        await tx.payrollProfile.create({
          data: {
            employeeProfileId: reusable.id,
            payrollDocuments: [],
            ...payrollFieldsFromSource,
          },
        })
      }

      // EmployeeOrganization is 1:1 with EmployeeProfile (unique
      // constraint on employeeProfileId), so it already exists —
      // no create/update needed. Un-archiving the PayrollProfile
      // above is what brings the membership back into
      // `listActiveMembershipsForUser`.
    } else {
      // ─── FRESH PATH ─────────────────────────────────────────────
      // First time at this org. Behaves the same as the pre-stints
      // implementation: create EmployeeProfile, PayrollProfile, and
      // EmployeeOrganization from scratch.
      const clash = await tx.employeeProfile.findFirst({
        where: {
          organizationId: transfer.targetOrganizationId,
          employeeId: source.employeeId,
        },
        select: { id: true },
      })
      const targetEmployeeCode = clash
        ? `${source.employeeId}-T`
        : source.employeeId

      const newProfile = await tx.employeeProfile.create({
        data: {
          userId: source.userId,
          organizationId: transfer.targetOrganizationId,
          employeeId: targetEmployeeCode,
          jobTitle: source.jobTitle,
          policyId: transfer.targetPolicyId,
          preferredCurrency: source.preferredCurrency,
        },
      })
      targetProfileId = newProfile.id

      await tx.payrollProfile.create({
        data: {
          employeeProfileId: newProfile.id,
          ...payrollFieldsFromSource,
          // payrollDocuments is Json (required, no default). Fresh
          // profile → empty; contracts/offer letters stay attached
          // to the source.
          payrollDocuments: [],
        },
      })

      await tx.employeeOrganization.create({
        data: {
          userId: source.userId,
          employeeProfileId: newProfile.id,
          organizationId: transfer.targetOrganizationId,
        },
      })
    }

    // 3) Open a new EmploymentStint on the target profile. Same
    //    write in both branches — that's the whole point of the
    //    stint model. Any previous CLOSED stint on this profile
    //    (from a prior tenure) stays intact for Form EA + audit.
    await employmentStintRepository.createStint(
      {
        employeeProfileId: targetProfileId,
        joinDate: effectiveDate,
        startReason: `Transferred from ${sourceOrgName}`,
        openedByTransferId: transfer.id,
      },
      tx,
    )

    // 4) Flip the queue row to EXECUTED atomically with the writes
    //    above so a failure anywhere rolls everything back.
    await tx.employeeTransfer.update({
      where: { id: transfer.id },
      data: {
        status: "EXECUTED",
        executedAt: new Date(),
        errorMessage: null,
      },
    })
  })

  // Bust caches at BOTH orgs — source's employee list needs the row
  // to disappear as archived; target's needs it to appear as fresh.
  // A transfer touches every surface the employee shows up on, so we
  // sweep all five feature areas (payroll, org config, attendance,
  // leave, claims) on both ends + the employee's own dashboard cache.
  await Promise.all([
    bustPayrollCaches({ organizationId: transfer.sourceOrganizationId }),
    bustPayrollCaches({ organizationId: transfer.targetOrganizationId }),
    bustOrgConfigCaches({ organizationId: transfer.sourceOrganizationId }),
    bustOrgConfigCaches({ organizationId: transfer.targetOrganizationId }),
    // Attendance: admin overview / roll-call / stats at both orgs
    // + the employee's own dashboard cache (their active-org
    // membership just changed).
    bustAttendanceCaches({ organizationId: transfer.sourceOrganizationId }),
    bustAttendanceCaches({ organizationId: transfer.targetOrganizationId }),
    bustAttendanceCaches({ employeeUserId: source.userId }),
    // Leave: "on leave today" counts + exec-overview at both orgs.
    // Target's leave-type list also drives dropdowns; source drops
    // the transferred employee from active counts.
    bustLeaveCaches({ organizationId: transfer.sourceOrganizationId }),
    bustLeaveCaches({ organizationId: transfer.targetOrganizationId }),
    // Claims: admin queue + exec-overview at both orgs; the per-user
    // submission-data cache (spend-limit dropdowns) resets so the
    // employee sees the target org's account list on next submit.
    bustClaimCaches({
      organizationId: transfer.sourceOrganizationId,
      userId: source.userId,
    }),
    bustClaimCaches({
      organizationId: transfer.targetOrganizationId,
      userId: source.userId,
    }),
  ])

  // Execution audit uses the SYSTEM actor — the cron / inline execute
  // path runs after the human left the wizard. The `.scheduled` event
  // already captured who initiated it.
  void writeAudit({
    organizationId: transfer.sourceOrganizationId,
    actor: { kind: "SYSTEM", name: "Employee Transfer" },
    action: "employee.transfer.executed",
    status: "SUCCESS",
    summary: `Executed transfer to ${targetOrg.name} (effective ${transfer.effectiveDate})`,
    targetType: "employee_profile",
    targetId: transfer.sourceEmployeeProfileId,
    metadata: {
      transferId: transfer.id,
      targetOrganizationId: transfer.targetOrganizationId,
      effectiveDate: transfer.effectiveDate,
      scheduledByUserId: transfer.createdByUserId,
    },
  })
}

/**
 * Cron entry point. Sweeps every PENDING (or previously FAILED)
 * transfer whose effectiveDate ≤ today and executes each one. Errors
 * are captured on the row so the next day's sweep retries.
 */
export async function executeDueTransfers(): Promise<{
  executed: number
  failed: number
}> {
  const now = new Date()
  const due = await payrollTransferRepository.listDueForExecution(now)
  let executed = 0
  let failed = 0
  for (const t of due) {
    try {
      await executeEmployeeTransfer({ transferId: t.id })
      executed += 1
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      await payrollTransferRepository.markFailed(t.id, msg)
      console.error("[executeDueTransfers] transfer failed", t.id, msg)
    }
  }
  return { executed, failed }
}

// ─── Private helpers ───────────────────────────────────────────────

async function requireAdminSession(): Promise<{
  userId: string
  email: string
  name: string
  role: "ADMIN" | "OWNER"
}> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  // Best-effort — the caller uses the returned session for audit
  // + org resolution. resolveActiveOrgId is not needed here (the
  // transfer flow explicitly passes sourceOrganizationId).
  void resolveActiveOrgId(session)
  return {
    userId: session.userId,
    email: session.email ?? "",
    name: session.name ?? "",
    role: session.role as "ADMIN" | "OWNER",
  }
}

/**
 * Parse an ISO yyyy-mm-dd date and return midnight UTC on that day,
 * or null if the string is malformed. Using UTC everywhere avoids
 * the "midnight KL vs midnight UTC" off-by-one that a `new Date(str)`
 * would introduce on effectiveDate comparisons.
 */
function parseISODate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  const d = new Date(`${iso}T00:00:00.000Z`)
  return Number.isFinite(d.getTime()) ? d : null
}

function startOfDayUtc(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  )
}
