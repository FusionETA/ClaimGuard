import "server-only"

import { getOrSetCache } from "@/lib/cache"
import { key } from "@/lib/redis"
import {
  availableDaysFor,
  initialProRatedAccrual,
} from "@/modules/leave/domain/accrual"
import type {
  LeaveAccrualMethod,
  LeaveEntitlementView,
} from "@/modules/leave/domain/models"
import {
  getLeavePrismaClient,
  getLeavePrismaClientSafe,
  leaveRepository,
} from "@/modules/leave/infrastructure/leave-repository"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import { getActiveAdminPolicyScope } from "@/modules/organization/application/services/admin-access.service"

/// Resolve the default entitlement days for an employee × leave type.
/// Resolution order:
///   1. Per-employee LeaveEntitlement override (handled by the caller; this
///      helper returns the *would-be* default, not the override).
///   2. PolicyLeaveEntitlement (if a row exists for the employee's policy).
///   3. LeaveType.defaultDays.
export async function resolveDefaultEntitledDays(
  employeeId: string,
  leaveTypeId: string,
): Promise<number> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return 0
  const [type, employee] = await Promise.all([
    prisma.leaveType.findUnique({ where: { id: leaveTypeId } }),
    prisma.employeeProfile.findFirst({
      where: { id: employeeId },
      select: { policyId: true },
    }),
  ])
  if (!type) return 0
  if (employee?.policyId) {
    const override = await prisma.policyLeaveEntitlement.findUnique({
      where: {
        policyId_leaveTypeId: { policyId: employee.policyId, leaveTypeId },
      },
    })
    if (override) return override.defaultDays
  }
  return type.defaultDays
}

/// Resolve the effective `accrualMethod` for an employee × leave type by
/// walking the 3-layer chain:
///   1. `LeaveEntitlement.accrualMethod` for the requested year — if
///      non-null, return it.
///   2. `PolicyLeaveEntitlement.accrualMethod` for the employee's policy
///      — if non-null, return it.
///   3. `LeaveType.accrualMethod` (always non-null).
///
/// Mirrors `resolveDefaultEntitledDays` above but for the method. Used
/// by every consumer that previously read `LeaveType.accrualMethod`
/// directly (the monthly cron, year rollover, balance view-mapper).
export async function resolveAccrualMethod(
  employeeId: string,
  leaveTypeId: string,
  year: number = currentYearMYT(),
): Promise<LeaveAccrualMethod> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return "LUMP_SUM"

  const [entitlement, type, employee] = await Promise.all([
    prisma.leaveEntitlement.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year },
      },
      select: { accrualMethod: true },
    }),
    prisma.leaveType.findUnique({
      where: { id: leaveTypeId },
      select: { accrualMethod: true, code: true },
    }),
    prisma.employeeProfile.findFirst({
      where: { id: employeeId },
      select: { policyId: true },
    }),
  ])

  // ANNUAL-only constraint: only Annual Leave can ever resolve to
  // PRO_RATED. Every other leave type is LUMP_SUM by design (Malaysian
  // statutory medical / compassionate / etc. are all lump-sum-at-hire-
  // anniversary). Defensive read: any leftover PRO_RATED override on
  // a non-ANNUAL type in the DB is ignored. See plan in
  // ~/.claude/plans/when-the-first-layer-synthetic-knuth.md.
  if (!isAnnualCode(type?.code)) return "LUMP_SUM"

  if (entitlement?.accrualMethod) {
    return entitlement.accrualMethod as LeaveAccrualMethod
  }
  if (employee?.policyId) {
    const policyOverride = await prisma.policyLeaveEntitlement.findUnique({
      where: {
        policyId_leaveTypeId: { policyId: employee.policyId, leaveTypeId },
      },
      select: { accrualMethod: true },
    })
    if (policyOverride?.accrualMethod) {
      return policyOverride.accrualMethod as LeaveAccrualMethod
    }
  }
  return (type?.accrualMethod ?? "LUMP_SUM") as LeaveAccrualMethod
}

/// Like `resolveAccrualMethod` but skips the LeaveEntitlement row's own
/// `accrualMethod` field. Used when the admin is about to clear the
/// per-employee override and we need to see what the row will resolve
/// to AFTER the clear (policy override → type default), without the
/// current row's value masking the answer.
async function resolveAccrualMethodWithoutRow(
  employeeId: string,
  leaveTypeId: string,
): Promise<LeaveAccrualMethod> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return "LUMP_SUM"
  const [type, employee] = await Promise.all([
    prisma.leaveType.findUnique({
      where: { id: leaveTypeId },
      select: { accrualMethod: true, code: true },
    }),
    prisma.employeeProfile.findFirst({
      where: { id: employeeId },
      select: { policyId: true },
    }),
  ])
  if (!isAnnualCode(type?.code)) return "LUMP_SUM"
  if (employee?.policyId) {
    const policyOverride = await prisma.policyLeaveEntitlement.findUnique({
      where: {
        policyId_leaveTypeId: { policyId: employee.policyId, leaveTypeId },
      },
      select: { accrualMethod: true },
    })
    if (policyOverride?.accrualMethod) {
      return policyOverride.accrualMethod as LeaveAccrualMethod
    }
  }
  return (type?.accrualMethod ?? "LUMP_SUM") as LeaveAccrualMethod
}

/// True iff this leave-type code identifies the Annual leave type.
/// Single source of truth for the ANNUAL-only PRO_RATED rule — every
/// other entry point reuses this so the constraint is consistent.
export function isAnnualCode(code: string | null | undefined): boolean {
  return (code ?? "").trim().toUpperCase() === "ANNUAL"
}

/// Same as `resolveAccrualMethod` but operates on already-loaded layer
/// values. Use this when batch-resolving many (employee, type) pairs to
/// avoid N+1 queries.
///
/// Pass `typeCode` so the ANNUAL-only constraint can be applied without
/// another DB lookup. Callers that already join `leaveType.code` (the
/// cron does) get short-circuiting for free.
export function resolveAccrualMethodFromLayers(layers: {
  employeeMethod: LeaveAccrualMethod | null
  policyMethod: LeaveAccrualMethod | null
  typeMethod: LeaveAccrualMethod
  typeCode?: string | null
}): LeaveAccrualMethod {
  if (layers.typeCode !== undefined && !isAnnualCode(layers.typeCode)) {
    return "LUMP_SUM"
  }
  return layers.employeeMethod ?? layers.policyMethod ?? layers.typeMethod
}

/// The current year in Asia/Kuala_Lumpur, used as the default year for
/// resolver lookups. Matches the cron's timezone choice so a Jan 1
/// firing crosses the year boundary at MYT midnight, not UTC midnight.
function currentYearMYT(now: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
    }).format(now),
  )
}

/// Ensure a LeaveEntitlement row exists for (employee, leaveType, year),
/// creating one with the resolved default if missing. Returns the row.
///
/// Race-safe: concurrent calls (e.g. parallel page loads invoking
/// listEmployeeBalances) can both miss the read, then both try to INSERT.
/// We catch the P2002 unique-constraint error and re-fetch — the other
/// caller already inserted the row, so the fetch succeeds.
export async function ensureEntitlement(
  employeeId: string,
  leaveTypeId: string,
  year: number,
) {
  const existing = await leaveRepository.getEntitlement(employeeId, leaveTypeId, year)
  if (existing) return existing
  const prisma = getLeavePrismaClient()
  const type = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } })
  if (!type) throw new Error("Leave type not found")
  const entitledDays = await resolveDefaultEntitledDays(employeeId, leaveTypeId)
  // Resolve the effective accrual method. No `LeaveEntitlement` row
  // exists at this point by definition, so the employee layer is
  // skipped — we walk policy → type. The created row carries
  // `accrualMethod = null` (inherit) so any future change at the
  // policy/type layer is picked up automatically.
  const effectiveMethod = await resolveAccrualMethod(employeeId, leaveTypeId, year)
  // For LUMP_SUM, accrued mirrors entitled (full availability immediately).
  // For PRO_RATED, seed with a join-date-aware backfill so an
  // employee who joined mid-year (or whose row is being created
  // lazily after several months have already elapsed) starts with
  // the accrual they *should* have had on day one. Without this,
  // the cron only adds 1/12 going forward and the employee silently
  // loses every accrual that fired before their row existed.
  let accruedDays: number
  if (effectiveMethod === "PRO_RATED") {
    const joinDate = await leaveRepository.getEmployeeJoinDate(employeeId)
    accruedDays = initialProRatedAccrual({
      entitledDays,
      joinDate,
      targetYear: year,
      now: new Date(),
    })
  } else if (type.prorateFirstYear && isAnnualCode(type.code)) {
    // LUMP_SUM Annual with "prorate first year" set: if the
    // employee joined in this seeding year, the year-of-hire amount
    // is prorated by months worked. Year 2+ gets full quota via the
    // year-rollover cron.
    const joinDate = await leaveRepository.getEmployeeJoinDate(employeeId)
    if (joinDate && joinDate.getUTCFullYear() === year) {
      accruedDays = initialProRatedAccrual({
        entitledDays,
        joinDate,
        targetYear: year,
        now: new Date(Date.UTC(year, 11, 31)),
      })
    } else {
      accruedDays = entitledDays
    }
  } else {
    accruedDays = entitledDays
  }
  try {
    return await leaveRepository.upsertEntitlement({
      employeeId,
      leaveTypeId,
      year,
      entitledDays,
      accruedDays,
      carriedDays: 0,
      carriedExpiresAt: null,
    })
  } catch (err) {
    // Someone else won the race — re-read and return their row.
    if (isUniqueConstraintError(err)) {
      const row = await leaveRepository.getEntitlement(employeeId, leaveTypeId, year)
      if (row) return row
    }
    throw err
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const code = (err as { code?: string }).code
  return code === "P2002"
}

/// Same as `listEmployeeBalances` but accepts a `User.id` and handles
/// the userId → employeeProfileId lookup internally. Pages and routes
/// should call this version so they don't have to touch Prisma directly
/// just to map the session userId.
///
/// Multi-org: pass `organizationId` so the balances belong to the
/// profile at the CURRENT active org. Without it, a user with
/// EmployeeProfiles at 2+ companies would fall back to the first
/// profile and read the wrong company's leave.
export async function listEmployeeBalancesForUser(
  userId: string,
  year: number,
  organizationId?: string,
): Promise<LeaveEntitlementView[]> {
  const profileId = await leaveRepository.findEmployeeProfileIdByUserId(
    userId,
    organizationId,
  )
  if (!profileId) return []
  // Cache under org:{orgId}:leave:balances:user:{userId}:{year}. Auto-
  // busted by `bustLeaveCaches({orgId})` — every leave apply / approve
  // / reject / cancel / entitlement change / type change already calls
  // that (see lib/cache-invalidation.ts, pattern `org:{orgId}:leave:*`).
  // Skips the cache when we don't know the org (would key without a
  // bust hook — better to just read fresh).
  if (!organizationId) {
    return listEmployeeBalances(profileId, year)
  }
  return getOrSetCache(
    key("org", organizationId, "leave", "balances", "user", userId, year),
    120,
    () => listEmployeeBalances(profileId, year),
  )
}

/// List a single employee's balances for the current year, including
/// computed `availableDays` per entitlement.
///
/// `skipEnsure` is set by callers that have already bulk-seeded missing
/// entitlements for a whole batch (org-wide balances view) — lets this
/// function skip its per-employee ensure loop (N×M queries → 0) and
/// just read.
export async function listEmployeeBalances(
  employeeId: string,
  year: number,
  opts: { skipEnsure?: boolean } = {},
): Promise<LeaveEntitlementView[]> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return []

  if (!opts.skipEnsure) {
    // Ensure rows exist for every non-archived leave type before reading.
    const types = await prisma.leaveType.findMany({
      where: {
        archivedAt: null,
        organization: { users: { some: { employeeProfiles: { some: { id: employeeId } } } } },
      },
      select: { id: true },
    })
    await Promise.all(types.map((t) => ensureEntitlement(employeeId, t.id, year)))
  }

  const rows = await leaveRepository.listEntitlementsForEmployee(employeeId, year)
  return rows.map((r) => ({
    ...r,
    availableDays: availableDaysFor({
      accrualMethod: r.accrualMethod,
      entitledDays: r.entitledDays,
      accruedDays: r.accruedDays,
      carriedDays: r.carriedDays,
      carriedExpired: r.carriedExpired,
      usedDays: r.usedDays,
    }),
  }))
}

/// Admin override of a single employee's entitlement for the year.
/// `entitledDays` is required; `accrualMethod` is optional — pass null
/// to clear the override (resolver walks up to policy/type), pass a
/// value to set the override, or omit (`undefined`) to leave the
/// existing per-employee override untouched.
export async function setEmployeeEntitlement(
  employeeId: string,
  leaveTypeId: string,
  year: number,
  entitledDays: number,
  accrualMethod?: LeaveAccrualMethod | null,
) {
  if (entitledDays < 0) throw new Error("Entitled days cannot be negative")
  const existing = await ensureEntitlement(employeeId, leaveTypeId, year)

  // Resolve the OLD effective method BEFORE we write so we can detect
  // a transition (LUMP_SUM → PRO_RATED requires reseeding accruedDays
  // from scratch; just capping the old value would leave the employee
  // sitting on the LUMP_SUM full quota).
  const previousEffectiveMethod = await resolveAccrualMethod(
    employeeId,
    leaveTypeId,
    year,
  )

  // Resolve the effective method AFTER the update:
  //   - explicit method passed → use it
  //   - null → admin clears the override; re-resolve through policy/type
  //     (skipping the row's own value, which is about to be nulled)
  //   - undefined → leave the existing per-employee value untouched,
  //     so the resolved value is the same as the previous one.
  let newEffectiveMethod: LeaveAccrualMethod
  if (accrualMethod !== undefined && accrualMethod !== null) {
    newEffectiveMethod = accrualMethod
  } else if (accrualMethod === null) {
    newEffectiveMethod = await resolveAccrualMethodWithoutRow(
      employeeId,
      leaveTypeId,
    )
  } else {
    newEffectiveMethod = previousEffectiveMethod
  }

  let accruedDays: number
  if (newEffectiveMethod === "PRO_RATED") {
    // Recompute accruedDays from the join-date-aware backfill for the
    // (possibly changed) entitledDays as-of now. This covers BOTH
    // transitioning INTO PRO_RATED and editing an already-PRO_RATED
    // row's entitled amount: in both cases the stored accruedDays must
    // track the new basis. Previously the already-PRO_RATED path only
    // capped the stale value (`Math.min(existing.accruedDays,
    // entitledDays)`), so raising the entitlement — or re-confirming the
    // method when the type default was already PRO_RATED — never moved
    // the balance. `initialProRatedAccrual` evaluated at `now` yields the
    // same months-elapsed value the monthly cron maintains, so this
    // preserves legitimate progress while caps internally at entitledDays.
    // Never drop below days the employee has already used.
    const joinDate = await leaveRepository.getEmployeeJoinDate(employeeId)
    const recomputed = initialProRatedAccrual({
      entitledDays,
      joinDate,
      targetYear: year,
      now: new Date(),
    })
    accruedDays = Math.max(recomputed, existing.usedDays)
  } else {
    // LUMP_SUM (or anything non-PRO_RATED) — fully credit.
    accruedDays = entitledDays
  }

  return leaveRepository.upsertEntitlement({
    employeeId,
    leaveTypeId,
    year,
    entitledDays,
    accruedDays,
    accrualMethod,
  })
}

/// Reset an employee's entitlement back to the resolved default
/// (policy override → leave type default). Clears BOTH `entitledDays`
/// override and `accrualMethod` override so the row inherits from the
/// next layer up for every field.
export async function resetEmployeeEntitlementToDefault(
  employeeId: string,
  leaveTypeId: string,
  year: number,
) {
  const days = await resolveDefaultEntitledDays(employeeId, leaveTypeId)
  return setEmployeeEntitlement(employeeId, leaveTypeId, year, days, null)
}

/// Count non-archived leave types for an org. The Add Employee dialog
/// uses this to guard against creating employees in an org with no
/// leave types configured — the seeder below would silently create
/// zero rows otherwise, and the employee would have no leave
/// entitlements at all.
export async function countActiveLeaveTypesForOrg(
  organizationId: string,
): Promise<number> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return 0
  return prisma.leaveType.count({
    where: { organizationId, archivedAt: null },
  })
}

/// Seed one `LeaveEntitlement` row per active leave type for a
/// newly-created employee. Called from `createOrganizationMember`
/// after the User + EmployeeProfile commit.
///
/// `mode = "DEFAULT"` ⇒ each row uses the resolved default (per-policy
/// → type fallback). No employee-layer override is stored.
///
/// `mode = "CUSTOM"` ⇒ each row uses the admin-supplied per-type
/// `entitledDays` and (optional) `accrualMethod`. Per-type overrides
/// not present in the input fall back to the resolved default for that
/// type, so the admin can override only the rows that matter.
///
/// Idempotent on every aggregate: re-runs hit `ensureEntitlement`'s
/// existing-row short-circuit and become no-ops. Safe for retried
/// form submissions.
export async function seedEmployeeLeaveEntitlements(args: {
  employeeProfileId: string
  leaveSeed: LeaveSeedInput
  year?: number
}): Promise<void> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return
  const year = args.year ?? currentYearMYT()

  // Scope leave types to the employee's organisation. An employee's
  // org is reachable via `employeeProfile.user.organizationId`.
  const employee = await prisma.employeeProfile.findFirst({
    where: { id: args.employeeProfileId },
    select: { user: { select: { organizationId: true } } },
  })
  const orgId = employee?.user.organizationId
  if (!orgId) return

  const types = await prisma.leaveType.findMany({
    where: { organizationId: orgId, archivedAt: null },
    select: {
      id: true,
      accrualMethod: true,
      defaultDays: true,
      code: true,
      prorateFirstYear: true,
    },
  })
  if (types.length === 0) return

  const overrides =
    args.leaveSeed.method === "CUSTOM" ? args.leaveSeed.overrides : null

  for (const t of types) {
    // Days: for ORG_DEFAULT use the type's own default (skip the policy
    // layer entirely); for CUSTOM use the admin-supplied override if
    // present; for DEFAULT walk the policy → type chain.
    let entitledDays: number
    if (args.leaveSeed.method === "ORG_DEFAULT") {
      entitledDays = Math.max(0, t.defaultDays ?? 0)
    } else if (overrides && overrides.days[t.id] !== undefined) {
      entitledDays = Math.max(0, overrides.days[t.id])
    } else {
      entitledDays = await resolveDefaultEntitledDays(
        args.employeeProfileId,
        t.id,
      )
    }

    // Method: only stored on the employee row if the admin explicitly
    // chose one in Custom mode (otherwise null = inherit from policy
    // / type, which is what we want by default).
    const explicitMethod =
      overrides?.methods[t.id] !== undefined ? overrides.methods[t.id] : null

    // Effective method for the accrued-days seed: for ORG_DEFAULT use
    // the type's accrual method directly (skip policy layer); for
    // CUSTOM/DEFAULT the explicit choice wins, then walk the chain.
    const effectiveMethod =
      args.leaveSeed.method === "ORG_DEFAULT"
        ? (t.accrualMethod ?? "LUMP_SUM")
        : (explicitMethod ??
          (await resolveAccrualMethod(args.employeeProfileId, t.id, year)))

    // For PRO_RATED, seed accruedDays with join-date-aware backfill.
    // For LUMP_SUM, accrued mirrors entitled — except when the leave
    // type opts into "prorate first year" AND the employee joined in
    // this seeding year. Year 2+ gets the full quota via the
    // year-rollover cron.
    let accruedDays: number
    if (effectiveMethod === "PRO_RATED") {
      const joinDate = await leaveRepository.getEmployeeJoinDate(
        args.employeeProfileId,
      )
      accruedDays = initialProRatedAccrual({
        entitledDays,
        joinDate,
        targetYear: year,
        now: new Date(),
      })
    } else if (t.prorateFirstYear && isAnnualCode(t.code)) {
      const joinDate = await leaveRepository.getEmployeeJoinDate(
        args.employeeProfileId,
      )
      if (joinDate && joinDate.getUTCFullYear() === year) {
        // Year-of-hire LUMP_SUM prorate: amount = entitledDays ×
        // (months remaining in year from join). Reuses
        // initialProRatedAccrual evaluated at year-end, which by
        // construction gives the total months-worked value.
        accruedDays = initialProRatedAccrual({
          entitledDays,
          joinDate,
          targetYear: year,
          now: new Date(Date.UTC(year, 11, 31)),
        })
      } else {
        // Joined in a previous year (or no joinDate): full quota.
        accruedDays = entitledDays
      }
    } else {
      accruedDays = entitledDays
    }

    try {
      await leaveRepository.upsertEntitlement({
        employeeId: args.employeeProfileId,
        leaveTypeId: t.id,
        year,
        entitledDays,
        accruedDays,
        carriedDays: 0,
        carriedExpiresAt: null,
        accrualMethod: explicitMethod,
      })
    } catch (err) {
      // Concurrent creation already inserted this row — accept and
      // move on. The other writer has the same data we'd write.
      if (!isUniqueConstraintError(err)) throw err
    }
  }
}

/// Recompute `accruedDays` for an employee's PRO_RATED entitlements
/// after their join date has changed. The seeder runs once at
/// employee creation; if the join date wasn't set then (or changed
/// later), the row's accruedDays is stuck at whatever the seeder
/// produced with the old/null join date.
///
/// **Safety filters** — only touches rows where:
///   1. The effective accrualMethod is PRO_RATED (LUMP_SUM unaffected).
///   2. `usedDays === 0` — the admin hasn't approved any leave yet,
///      so adjusting the accrual isn't moving goalposts under the
///      employee. Once they've used any of the entitlement, we leave
///      it alone.
///   3. The current `entitledDays` matches the resolved default — i.e.
///      the admin hasn't set a per-employee days override. If they
///      did, we assume they typed the exact number they wanted and
///      it's not safe to overwrite.
///   4. The per-employee `accrualMethod` override is null (otherwise
///      the admin pinned the method on purpose; touching accrued
///      could surprise them).
///
/// Fire-and-forget on errors — a failure here logs and returns so
/// the underlying join-date save still succeeds.
export async function recomputeProRatedAccrualForEmployee(
  employeeProfileId: string,
  year: number = currentYearMYT(),
): Promise<{ touched: number }> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return { touched: 0 }

  try {
    const joinDate = await leaveRepository.getEmployeeJoinDate(
      employeeProfileId,
    )

    const rows = await prisma.leaveEntitlement.findMany({
      where: { employeeId: employeeProfileId, year, usedDays: 0 },
      include: {
        leaveType: {
          select: {
            id: true,
            accrualMethod: true,
            code: true,
            prorateFirstYear: true,
          },
        },
      },
    })

    let touched = 0
    for (const row of rows) {
      // Filter 4: skip rows with an explicit per-employee method override.
      if (row.accrualMethod !== null) continue

      // Filter 1: effective method drives which recompute path to use.
      const effectiveMethod = await resolveAccrualMethod(
        employeeProfileId,
        row.leaveTypeId,
        year,
      )

      // For PRO_RATED, recompute via the standard backfill helper.
      // For LUMP_SUM with prorate-first-year + Annual + this-year
      // hire, recompute the year-end full-year prorated total.
      // Anything else: skip.
      const isLumpSumProrate =
        effectiveMethod === "LUMP_SUM" &&
        row.leaveType.prorateFirstYear &&
        isAnnualCode(row.leaveType.code) &&
        joinDate?.getUTCFullYear() === year

      if (effectiveMethod !== "PRO_RATED" && !isLumpSumProrate) continue

      // Filter 3: skip if entitledDays differs from the resolved
      // default (i.e. admin has overridden days for this row).
      const resolvedDays = await resolveDefaultEntitledDays(
        employeeProfileId,
        row.leaveTypeId,
      )
      if (row.entitledDays !== resolvedDays) continue

      // For LUMP_SUM-prorate the year-of-hire amount is fixed at
      // hire (not growing through the year), so we evaluate the
      // helper at year-end. For PRO_RATED, we evaluate at "now"
      // because the value should grow through the year.
      const now = isLumpSumProrate
        ? new Date(Date.UTC(year, 11, 31))
        : new Date()
      const nextAccrued = initialProRatedAccrual({
        entitledDays: row.entitledDays,
        joinDate,
        targetYear: year,
        now,
      })

      // Skip the write when nothing changed (avoids burning Redis
      // bust + revalidate work on a no-op).
      if (Math.abs(nextAccrued - row.accruedDays) < 0.005) continue

      await prisma.leaveEntitlement.update({
        where: { id: row.id },
        data: { accruedDays: nextAccrued },
      })
      touched += 1
    }
    return { touched }
  } catch (err) {
    // Don't bubble — the caller's primary mutation (saving the
    // PayrollProfile) already succeeded.
    console.warn(
      "[recomputeProRatedAccrualForEmployee] failed:",
      err,
    )
    return { touched: 0 }
  }
}

/// Input shape for `seedEmployeeLeaveEntitlements`. Kept narrow on
/// purpose so the action layer can construct it from FormData without
/// branching, and so future callers (bulk import, partner API) can
/// reuse the same surface.
export type LeaveSeedInput =
  | { method: "ORG_DEFAULT" }
  | { method: "DEFAULT" }
  | {
      method: "CUSTOM"
      overrides: {
        days: Record<string, number>
        methods: Record<string, LeaveAccrualMethod>
      }
    }

/// Per-employee balance bundle used by the admin and supervisor list
/// views. Carries enough identity info to render a row label without an
/// extra round-trip.
export type EmployeeLeaveBalances = {
  userId: string
  employeeProfileId: string
  name: string
  email: string
  role: "EMPLOYEE" | "SUPERVISOR" | "ADMIN" | "OWNER"
  jobTitle: string
  balances: LeaveEntitlementView[]
  /// Where this employee's leave config resolves from, overall:
  ///   "custom"  — any per-employee LeaveEntitlement override is set
  ///   "policy"  — no per-employee override, but their policy has
  ///               at least one PolicyLeaveEntitlement override
  ///   "default" — both layers empty; type defaults all the way
  ///
  /// Pre-computed server-side so the admin balances grid doesn't
  /// have to re-derive it per render. The supervisor view ignores
  /// this field.
  leaveSource: "default" | "policy" | "custom"
}

/// All employees in an org with their leave balances for the given year.
/// Admin view (`/admin/leave/balances`) consumes this. Iterates the
/// per-employee balance fetcher so each row gets the same
/// `ensureEntitlement` + availableDays computation it would as a single
/// fetch — guaranteeing rows exist for every active leave type and
/// avoiding "missing entitlement" gaps after the year rollover.
export async function listAllEmployeeBalancesForOrg(
  organizationId: string,
  year: number,
): Promise<EmployeeLeaveBalances[]> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return []

  // Per-admin policy scope — restricted admins only see their granted
  // policies' employee balances. Empty scope → 0 rows.
  const policyIdScope = await getActiveAdminPolicyScope()
  if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []

  // Cache the full org-wide balance grid. Per-admin policy grants
  // partition the result so two admins with different scopes don't
  // share entries. Auto-busted by `bustLeaveCaches({orgId})` — every
  // leave apply / approve / reject / cancel / entitlement change /
  // type change fires that. 120s TTL is the safety net for missed busts.
  const scopeTag =
    policyIdScope === null ? "_all" : `p:${[...policyIdScope].sort().join(",")}`
  return getOrSetCache(
    key("org", organizationId, "leave", "balances", "org", scopeTag, year),
    120,
    () => loadAllEmployeeBalancesForOrg(prisma, organizationId, policyIdScope, year),
  )
}

/// Bulk-check + bulk-seed missing entitlement rows across a whole org
/// for one year. Called once at the top of the org-wide balances view
/// to eliminate the per-employee ensureEntitlement N+1.
///
/// Runs one SELECT to find the existing (employee, leaveType) pairs,
/// diffs against the full grid, then only calls `ensureEntitlement` for
/// the missing pairs. On a stable org where every employee already has
/// entitlements, that's 2 queries total (types + existing) — vs the
/// old N×M SELECT storm.
async function ensureEntitlementsForOrgYear(input: {
  prisma: NonNullable<ReturnType<typeof getLeavePrismaClientSafe>>
  organizationId: string
  employeeIds: string[]
  year: number
}): Promise<void> {
  const { prisma, organizationId, employeeIds, year } = input
  if (employeeIds.length === 0) return
  const types = await prisma.leaveType.findMany({
    where: { organizationId, archivedAt: null },
    select: { id: true },
  })
  if (types.length === 0) return
  const existing = await prisma.leaveEntitlement.findMany({
    where: {
      year,
      employeeId: { in: employeeIds },
      leaveTypeId: { in: types.map((t) => t.id) },
    },
    select: { employeeId: true, leaveTypeId: true },
  })
  const seen = new Set(existing.map((e) => `${e.employeeId}:${e.leaveTypeId}`))
  const missing: Array<{ employeeId: string; leaveTypeId: string }> = []
  for (const empId of employeeIds) {
    for (const t of types) {
      if (!seen.has(`${empId}:${t.id}`)) {
        missing.push({ employeeId: empId, leaveTypeId: t.id })
      }
    }
  }
  if (missing.length === 0) return
  // ensureEntitlement handles the P2002 race — safe to fire in parallel.
  await Promise.all(
    missing.map((m) => ensureEntitlement(m.employeeId, m.leaveTypeId, year)),
  )
}

async function loadAllEmployeeBalancesForOrg(
  prisma: NonNullable<ReturnType<typeof getLeavePrismaClientSafe>>,
  organizationId: string,
  policyIdScope: string[] | null,
  year: number,
): Promise<EmployeeLeaveBalances[]> {
  const employees = await prisma.employeeProfile.findMany({
    where: {
      user: { organizationId, role: { in: ["EMPLOYEE", "SUPERVISOR"] } },
      ...(policyIdScope && policyIdScope.length > 0
        ? { policyId: { in: policyIdScope } }
        : {}),
    },
    select: {
      id: true,
      policyId: true,
      jobTitle: true,
      user: { select: { id: true, name: true, email: true, role: true } },
    },
    orderBy: { user: { name: "asc" } },
  })

  // Bulk pre-seed missing entitlements for the (employee × type) grid.
  // Kills the N+1 that the per-employee `listEmployeeBalances` used to
  // trigger — used to fire N×M ensureEntitlement SELECTs (~1,000+ for a
  // 190-employee, 5-type org) even when every row already existed.
  await ensureEntitlementsForOrgYear({
    prisma,
    organizationId,
    employeeIds: employees.map((e) => e.id),
    year,
  })

  // Pre-load type-defaults and policy-overrides once for the org so
  // computeLeaveSource doesn't need N×T extra queries.
  const ctx = await loadLeaveSourceContext(prisma, organizationId)

  return Promise.all(
    employees.map(async (e) => ({
      userId: e.user.id,
      employeeProfileId: e.id,
      name: e.user.name,
      email: e.user.email,
      role: e.user.role as EmployeeLeaveBalances["role"],
      jobTitle: e.jobTitle,
      // `skipEnsure` — bulk pre-seed above already covered this employee.
      balances: await listEmployeeBalances(e.id, year, { skipEnsure: true }),
      leaveSource: await computeLeaveSourceForEmployee({
        prisma,
        employeeProfileId: e.id,
        employeePolicyId: e.policyId,
        year,
        ctx,
      }),
    })),
  )
}

/// Loads the per-org data needed to classify each employee's
/// leave source. Shared by both balance list endpoints so the
/// supervisor view also gets the same labelling for the (yet-unused)
/// leaveSource field.
async function loadLeaveSourceContext(
  prisma: NonNullable<ReturnType<typeof getLeavePrismaClientSafe>>,
  organizationId: string,
) {
  const [types, policyDefaults] = await Promise.all([
    prisma.leaveType.findMany({
      where: { organizationId, archivedAt: null },
      select: { id: true, paid: true, defaultDays: true, accrualMethod: true },
    }),
    prisma.policyLeaveEntitlement.findMany({
      where: { policy: { organizationId } },
      select: {
        policyId: true,
        leaveTypeId: true,
        defaultDays: true,
        accrualMethod: true,
      },
    }),
  ])
  return {
    typesById: new Map(types.map((t) => [t.id, t])),
    policyDefaults,
  }
}

async function computeLeaveSourceForEmployee(args: {
  prisma: NonNullable<ReturnType<typeof getLeavePrismaClientSafe>>
  employeeProfileId: string
  employeePolicyId: string | null
  year: number
  ctx: Awaited<ReturnType<typeof loadLeaveSourceContext>>
}): Promise<"default" | "policy" | "custom"> {
  const entitlements = await args.prisma.leaveEntitlement.findMany({
    where: { employeeId: args.employeeProfileId, year: args.year },
    select: {
      leaveTypeId: true,
      entitledDays: true,
      accrualMethod: true,
    },
  })

  // Pass 1 — any per-employee override on a paid type?
  for (const e of entitlements) {
    const t = args.ctx.typesById.get(e.leaveTypeId)
    if (!t || !t.paid) continue
    if (e.accrualMethod !== null) return "custom"
    const policyForThis = args.ctx.policyDefaults.find(
      (d) =>
        d.policyId === args.employeePolicyId &&
        d.leaveTypeId === e.leaveTypeId,
    )
    const resolvedDefault = policyForThis?.defaultDays ?? t.defaultDays
    if (Math.abs(e.entitledDays - resolvedDefault) > 0.001) return "custom"
  }

  // Pass 2 — any policy override on the employee's policy?
  if (args.employeePolicyId) {
    for (const d of args.ctx.policyDefaults) {
      if (d.policyId !== args.employeePolicyId) continue
      const t = args.ctx.typesById.get(d.leaveTypeId)
      if (!t || !t.paid) continue
      if (d.accrualMethod !== null) return "policy"
      if (Math.abs(d.defaultDays - t.defaultDays) > 0.001) return "policy"
    }
  }
  return "default"
}

/// Direct-reports view for supervisors. Returns balances only for the
/// employees the supervisor is in the approval chain for (any module),
/// reusing the existing `attendanceRepository.getTeamMemberIds()` lookup
/// so "who reports to me" stays in one place. Returns [] when the
/// supervisor has no direct reports configured.
export async function listTeamBalancesForSupervisor(
  supervisorUserId: string,
  year: number,
): Promise<EmployeeLeaveBalances[]> {
  const prisma = getLeavePrismaClientSafe()
  if (!prisma) return []

  const memberIds = await attendanceRepository.getTeamMemberIds(supervisorUserId)
  if (memberIds.length === 0) return []

  const employees = await prisma.employeeProfile.findMany({
    where: { userId: { in: memberIds } },
    select: {
      id: true,
      policyId: true,
      jobTitle: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          organizationId: true,
        },
      },
    },
    orderBy: { user: { name: "asc" } },
  })

  // Use whichever org the team members belong to (they all share one
  // — supervisor + reports are always in the same org).
  const orgId = employees[0]?.user.organizationId
  const ctx = orgId ? await loadLeaveSourceContext(prisma, orgId) : null

  return Promise.all(
    employees.map(async (e) => ({
      userId: e.user.id,
      employeeProfileId: e.id,
      name: e.user.name,
      email: e.user.email,
      role: e.user.role as EmployeeLeaveBalances["role"],
      jobTitle: e.jobTitle,
      balances: await listEmployeeBalances(e.id, year),
      leaveSource: ctx
        ? await computeLeaveSourceForEmployee({
            prisma,
            employeeProfileId: e.id,
            employeePolicyId: e.policyId,
            year,
            ctx,
          })
        : ("default" as const),
    })),
  )
}
