import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import { toNumber } from "@/lib/decimal"
import {
  isExcludedFromPayroll,
  isPayrollProfileComplete,
  PAYROLL_ADJUSTMENT_CATEGORY_META,
  payrollAdjustmentCategories,
} from "@/modules/payroll/domain/models"
import type {
  ChildRelief,
  FixedAllowance,
  LeaveEntitlement,
  PayrollDocument,
  PayrollEmployeeRow,
  PayrollProfileData,
} from "@/modules/payroll/domain/models"
import { normaliseChildStudyingLevel } from "@/modules/payroll/domain/models"

/**
 * Prisma-side repository for `PayrollProfile`. Projects Prisma rows
 * into the app-friendly `PayrollProfileData` shape (Decimals → numbers,
 * Json → typed arrays, etc.). All Prisma access for the payroll-profile
 * aggregate lives here per the layered architecture rule.
 */
export const payrollProfileRepository = {
  /**
   * Fetch a payroll profile by the employee's `EmployeeProfile.id`.
   * Returns null when the employee hasn't been onboarded into payroll
   * yet (no PayrollProfile row exists).
   */
  async getByEmployeeProfileId(
    employeeProfileId: string,
  ): Promise<PayrollProfileData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.payrollProfile.findUnique({
      where: { employeeProfileId },
    })
    if (!row) return null
    return mapPayrollProfile(row)
  },

  /**
   * Fetch a payroll profile by the employee's `User.id`. Convenience
   * for routes that use User id (e.g.
   * `/admin/payroll/employees/[id]`).
   */
  async getByUserId(userId: string): Promise<PayrollProfileData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const profile = await prisma.employeeProfile.findFirst({
      where: { userId },
      select: { id: true },
    })
    if (!profile) return null
    return this.getByEmployeeProfileId(profile.id)
  },

  /**
   * Find temporary employees whose review date has arrived (on or before
   * `cutoff`). Only includes active employees whose assigned policy is
   * temporary. Used by the temporary-review reminder cron.
   */
  async findDueTemporaryReviews(cutoff: Date): Promise<
    Array<{
      userId: string
      employeeName: string
      organizationId: string
      reviewDate: string // ISO yyyy-mm-dd
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const rows = await prisma.payrollProfile.findMany({
      where: {
        isArchived: false,
        temporaryReviewDate: { not: null, lte: cutoff },
        employeeProfile: { policy: { temporary: true } },
      },
      select: {
        temporaryReviewDate: true,
        employeeProfile: {
          select: {
            user: {
              select: { id: true, name: true, organizationId: true },
            },
          },
        },
      },
    })

    const out: Array<{
      userId: string
      employeeName: string
      organizationId: string
      reviewDate: string
    }> = []
    for (const row of rows) {
      const user = row.employeeProfile?.user
      if (!user || !user.organizationId || !row.temporaryReviewDate) continue
      out.push({
        userId: user.id,
        employeeName: user.name,
        organizationId: user.organizationId,
        reviewDate: row.temporaryReviewDate.toISOString().slice(0, 10),
      })
    }
    return out
  },

  /**
   * Upsert: create the profile if missing, otherwise patch the supplied
   * fields. `employeeProfileId` is the lookup key. Anything not in
   * `patch` is left untouched (PATCH semantics).
   *
   * `salaryType` is required on first create — the model has no
   * default. If the row doesn't exist yet, the caller must supply it.
   */
  async upsert(input: {
    employeeProfileId: string
    /// All other fields are optional patches; `salaryType` is required
    /// on first-create so we always have a valid payroll config.
    patch: Partial<Omit<PayrollProfileData, "id" | "employeeProfileId" | "createdAt" | "updatedAt">>
  }): Promise<PayrollProfileData> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const data = toPrismaUpsertData(input.patch)

    const row = await prisma.payrollProfile.upsert({
      where: { employeeProfileId: input.employeeProfileId },
      create: {
        employeeProfileId: input.employeeProfileId,
        // On first create, salaryType must be provided. If the caller
        // forgot, default to MONTHLY rather than crashing — the admin
        // can fix it in the form.
        salaryType: input.patch.salaryType ?? "MONTHLY",
        payrollDocuments: [],
        ...data,
      },
      update: data,
    })

    return mapPayrollProfile(row)
  },

  /**
   * List all employees in an org with their payroll-profile state, for
   * the admin "Payroll → Employees" page. Always returns every employee
   * (whether or not they have a PayrollProfile) so the admin sees who
   * still needs onboarding.
   */
  async listForOrganization(
    organizationId: string,
    options?: { policyIdScope?: string[] | null },
  ): Promise<PayrollEmployeeRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []

    // Pull all employees in the org with their EmployeeProfile +
    // optional PayrollProfile in one query.
    //
    // Multi-org: scope by `EmployeeProfile.organizationId` only. The
    // previous also-filter on `User.organizationId` was redundant AND
    // buggy for the link path — a user linked from Company A to
    // Company B keeps `User.organizationId = Company A` (their home
    // org) but gets a fresh EmployeeProfile at Company B. The User-
    // level filter would then hide them from Company B's payroll.
    const users = await prisma.user.findMany({
      where: {
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        employeeProfiles: {
          some: {
            organizationId,
            ...(policyIdScope && policyIdScope.length > 0
              ? { policyId: { in: policyIdScope } }
              : {}),
          },
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        employeeProfiles: {
          where: { organizationId },
          select: {
            id: true,
            employeeId: true,
            jobTitle: true,
            payrollProfile: true, // full row when present, null otherwise
          },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    })

    return users
      .filter((u) => u.employeeProfiles[0] !== undefined)
      .map((u) => {
        const ep = u.employeeProfiles[0]!
        const pp = ep.payrollProfile
        const projected = pp ? mapPayrollProfile(pp) : null
        return {
          userId: u.id,
          employeeProfileId: ep.id,
          employeeId: ep.employeeId,
          name: u.name,
          email: u.email,
          jobTitle: ep.jobTitle,
          salaryType: projected?.salaryType ?? "MONTHLY",
          hasProfile: pp !== null,
          isComplete: projected ? isPayrollProfileComplete(projected) : false,
          isArchived: projected?.isArchived ?? false,
          isExcluded: projected ? isExcludedFromPayroll(projected) : false,
          // Pass through so the run-detail page's `isReadyForPayroll`
          // call can exclude not-yet-started / already-left employees
          // when given a period.
          joinDate: projected?.joinDate ?? null,
          leaveDate: projected?.leaveDate ?? null,
        }
      })
  },

  /**
   * Full employee master for the CSV export — every field the import
   * template carries, so an export re-imports cleanly. Returns the
   * projected PayrollProfile (clean JS types, ISO dates) plus the
   * identity + hierarchy names the export needs. Includes employees
   * regardless of profile completeness so nobody is silently dropped.
   */
  async listForExport(organizationId: string): Promise<
    Array<{
      name: string
      email: string
      employeeType: "EMPLOYEE" | "SUPERVISOR"
      employeeId: string
      jobTitle: string | null
      policyName: string | null
      projectName: string | null
      teamName: string | null
      teamLayer: number | null
      profile: PayrollProfileData | null
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const users = await prisma.user.findMany({
      where: {
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        employeeProfiles: { some: { organizationId } },
      },
      select: {
        name: true,
        email: true,
        role: true,
        employeeProfiles: {
          where: { organizationId },
          select: {
            employeeId: true,
            jobTitle: true,
            policy: { select: { name: true } },
            projectAssignments: {
              select: { project: { select: { name: true } } },
              take: 1,
            },
            teamMemberships: {
              select: { layer: true, team: { select: { name: true } } },
              take: 1,
            },
            payrollProfile: true,
          },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    })

    return users
      .filter((u) => u.employeeProfiles[0] !== undefined)
      .map((u) => {
        const ep = u.employeeProfiles[0]!
        return {
          name: u.name,
          email: u.email,
          employeeType: u.role === "SUPERVISOR" ? "SUPERVISOR" : "EMPLOYEE",
          employeeId: ep.employeeId,
          jobTitle: ep.jobTitle,
          policyName: ep.policy?.name ?? null,
          projectName: ep.projectAssignments[0]?.project.name ?? null,
          teamName: ep.teamMemberships[0]?.team.name ?? null,
          teamLayer: ep.teamMemberships[0]?.layer ?? null,
          profile: ep.payrollProfile
            ? mapPayrollProfile(ep.payrollProfile)
            : null,
        }
      })
  },

  /**
   * Fuller projection for YTD import row matching — every employee in
   * the org with the FK identifiers + identity fields needed to write
   * a Payslip snapshot. Used after parsing the upload to look up each
   * row's (idType, idNumber) → (employeeProfileId, payrollProfileId,
   * snapshot defaults).
   *
   * Returns employees regardless of payroll-profile completeness; the
   * importer trusts the uploaded numbers, so an incomplete profile is
   * still importable (the engine-computed path would skip them, but
   * imports don't go through the engine).
   */
  async listEmployeesForImportMatch(organizationId: string): Promise<
    Array<{
      employeeProfileId: string
      payrollProfileId: string | null
      employeeId: string
      name: string
      idType: "NRIC" | "PASSPORT" | "OTHER" | null
      idNumber: string | null
      nationality: string | null
      isResident: boolean
      salaryType: "MONTHLY" | "HOURLY"
      monthlySalary: number | null
      jobTitle: string | null
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []
    // Multi-org: filter by EmployeeProfile.organizationId only, not
    // User.organizationId — linked employees have User.organizationId
    // pointing at their FIRST company, not this one.
    const users = await prisma.user.findMany({
      where: {
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        employeeProfiles: { some: { organizationId } },
      },
      select: {
        name: true,
        employeeProfiles: {
          where: { organizationId },
          select: {
            id: true,
            employeeId: true,
            jobTitle: true,
            payrollProfile: true,
          },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    })
    const out: Array<{
      employeeProfileId: string
      payrollProfileId: string | null
      employeeId: string
      name: string
      idType: "NRIC" | "PASSPORT" | "OTHER" | null
      idNumber: string | null
      nationality: string | null
      isResident: boolean
      salaryType: "MONTHLY" | "HOURLY"
      monthlySalary: number | null
      jobTitle: string | null
    }> = []
    for (const u of users) {
      const ep = u.employeeProfiles[0]
      if (!ep) continue
      const pp = ep.payrollProfile
      const projected = pp ? mapPayrollProfile(pp) : null
      const rawIdType =
        typeof projected?.idType === "string"
          ? (projected.idType as string).toUpperCase()
          : null
      const idType: "NRIC" | "PASSPORT" | "OTHER" | null =
        rawIdType === "NRIC" || rawIdType === "PASSPORT"
          ? rawIdType
          : rawIdType
            ? "OTHER"
            : null
      out.push({
        employeeProfileId: ep.id,
        payrollProfileId: pp?.id ?? null,
        employeeId: ep.employeeId,
        name: u.name,
        idType,
        idNumber: projected?.idNumber ?? null,
        nationality: projected?.nationality ?? null,
        isResident: projected?.isResident ?? true,
        salaryType: projected?.salaryType ?? "MONTHLY",
        monthlySalary: projected?.monthlySalary ?? null,
        jobTitle: ep.jobTitle ?? null,
      })
    }
    return out
  },

  /**
   * Minimal identity projection for the YTD import template — name +
   * id-type + id-number per employee in the org, ordered alphabetically.
   * Includes employees regardless of payroll-profile completeness;
   * admins migrating mid-year may have a partially-onboarded roster
   * and we still want their identity rows pre-filled in the XLSX.
   * Excludes ADMIN-role users since they don't take payroll.
   */
  async listIdentityForImport(organizationId: string): Promise<
    Array<{
      name: string
      idType: "NRIC" | "PASSPORT" | "OTHER" | null
      idNumber: string | null
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    // Multi-org: same as the two lookups above — profile-scoped, not
    // User-scoped, so linked employees appear at every org they hold
    // an EmployeeProfile in.
    const users = await prisma.user.findMany({
      where: {
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        employeeProfiles: { some: { organizationId } },
      },
      select: {
        name: true,
        employeeProfiles: {
          where: { organizationId },
          select: {
            payrollProfile: { select: { idType: true, idNumber: true } },
          },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    })

    return users.map((u) => {
      const pp = u.employeeProfiles[0]?.payrollProfile
      // Prisma's generated enum type doesn't widen — narrow to the
      // strings our template renderer expects. Unknown values fall
      // back to "OTHER" so the prefix on the template reads "Other:".
      const rawIdType =
        typeof pp?.idType === "string"
          ? (pp.idType as string).toUpperCase()
          : null
      const idType: "NRIC" | "PASSPORT" | "OTHER" | null =
        rawIdType === "NRIC" || rawIdType === "PASSPORT"
          ? rawIdType
          : rawIdType
            ? "OTHER"
            : null
      return {
        name: u.name,
        idType,
        idNumber: pp?.idNumber ?? null,
      }
    })
  },

  /**
   * Fetch every employee in the org with a COMPLETE and non-archived
   * payroll profile. Used by the payroll-run generator: these are the
   * employees who will get a payslip on the next run.
   *
   * Returns full identity + the projected PayrollProfile, so the calc
   * engine has everything it needs without re-querying.
   */
  async listReadyForPayroll(
    organizationId: string,
    options?: {
      policyIdScope?: string[] | null
      /// Optional period window. When set, employees whose `joinDate`
      /// is after the period end (haven't started yet) OR whose
      /// `leaveDate` is before the period start (already left) are
      /// excluded — they shouldn't be paid for that month at all.
      /// Omit for legacy callers (preview / counts) that want the
      /// raw eligible list regardless of period.
      period?: { year: number; month: number }
    },
  ): Promise<
    Array<{
      userId: string
      employeeProfileId: string
      employeeId: string
      name: string
      email: string
      jobTitle: string
      profile: PayrollProfileData
      /// Assigned policy id (null = legacy, no policy). The payroll-run
      /// service uses this to resolve per-employee OT rates.
      policyId: string | null
      /// Primary project hours, used to derive dailyHours for the
      /// monthly→hourly conversion. Null when the employee has no
      /// project assignment with working hours configured.
      primaryProject: {
        workingHoursStart: string | null
        workingHoursEnd: string | null
        lunchBreakMinutes: number | null
        workingDays: string | null
      } | null
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []

    const policyIdScope = options?.policyIdScope ?? null
    if (Array.isArray(policyIdScope) && policyIdScope.length === 0) return []

    // Mirror the listForOrganization shape — Prisma's nested filter for
    // optional 1:1 + non-null + property-match is awkward; we filter
    // in memory, which is cheap at org-scale headcounts.
    const users = await prisma.user.findMany({
      where: {
        organizationId,
        role: { in: ["EMPLOYEE", "SUPERVISOR"] },
        employeeProfiles: {
          some: {
            organizationId,
            ...(policyIdScope && policyIdScope.length > 0
              ? { policyId: { in: policyIdScope } }
              : {}),
          },
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        employeeProfiles: {
          where: { organizationId },
          select: {
            id: true,
            employeeId: true,
            jobTitle: true,
            policyId: true,
            payrollProfile: true,
            /// Stint history for the period-window filter below.
            /// One row per past-or-present tenure at this org.
            stints: {
              select: { joinDate: true, leaveDate: true },
              orderBy: { joinDate: "asc" },
            },
            projectAssignments: {
              select: {
                project: {
                  select: {
                    workingHoursStart: true,
                    workingHoursEnd: true,
                    lunchBreakMinutes: true,
                    workingDays: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    })

    const rows: Array<{
      userId: string
      employeeProfileId: string
      employeeId: string
      name: string
      email: string
      jobTitle: string
      profile: PayrollProfileData
      policyId: string | null
      primaryProject: {
        workingHoursStart: string | null
        workingHoursEnd: string | null
        lunchBreakMinutes: number | null
        workingDays: string | null
      } | null
    }> = []

    // Build the period window (UTC) once. We compare against UTC dates
    // because join/leave dates are stored at midnight UTC.
    const periodStart = options?.period
      ? new Date(Date.UTC(options.period.year, options.period.month - 1, 1))
      : null
    const periodEnd = options?.period
      ? new Date(
          Date.UTC(options.period.year, options.period.month, 0, 23, 59, 59, 999),
        )
      : null

    for (const u of users) {
      const ep = u.employeeProfiles[0]
      if (!ep || !ep.payrollProfile) continue
      const profile = mapPayrollProfile(ep.payrollProfile)
      if (profile.isArchived) continue
      if (!isPayrollProfileComplete(profile)) continue
      // Salary = 0 is an intentional opt-out — skip these employees from
      // the run draft. See `isExcludedFromPayroll` for the rationale.
      if (isExcludedFromPayroll(profile)) continue
      // Period-aware exclusion. Preferred check: does ANY stint
      // overlap the period window? A stint overlaps when
      //   stint.joinDate  ≤ periodEnd
      //   AND (stint.leaveDate IS NULL OR stint.leaveDate ≥ periodStart)
      //
      // Fallback for legacy profiles that haven't been backfilled with
      // any stint row: use the denormalised joinDate/leaveDate on
      // PayrollProfile — same predicate as before this rollout. Once
      // the backfill runs everywhere the fallback becomes unreachable.
      if (periodStart && periodEnd) {
        if (ep.stints.length > 0) {
          const anyOverlaps = ep.stints.some((s) => {
            const join = new Date(s.joinDate)
            if (join.getTime() > periodEnd.getTime()) return false
            if (s.leaveDate) {
              const leave = new Date(s.leaveDate)
              if (leave.getTime() < periodStart.getTime()) return false
            }
            return true
          })
          if (!anyOverlaps) continue
        } else {
          if (profile.joinDate) {
            const join = new Date(profile.joinDate)
            if (join.getTime() > periodEnd.getTime()) continue
          }
          if (profile.leaveDate) {
            const leave = new Date(profile.leaveDate)
            if (leave.getTime() < periodStart.getTime()) continue
          }
        }
      }
      const primaryProject = ep.projectAssignments[0]?.project ?? null
      rows.push({
        userId: u.id,
        employeeProfileId: ep.id,
        employeeId: ep.employeeId,
        name: u.name,
        email: u.email,
        jobTitle: ep.jobTitle,
        profile,
        policyId: ep.policyId ?? null,
        primaryProject,
      })
    }

    return rows
  },

  /**
   * Archive an employee with a specific last-working-day date.
   *
   * `leaveDate` is the date the admin enters in the archive card. It's
   * the employee's last day on payroll — the payroll calc engine reads
   * this column to prorate the final pay run (e.g. someone with
   * leaveDate = 20 May still gets paid for 1–20 May on the May run, and
   * is excluded from June onwards).
   *
   * `archivedAt` is separately set to `now()` — it's the audit
   * timestamp for "when did admin click archive", not the leave date.
   */
  /**
   * Find every non-archived PayrollProfile whose leaveDate is strictly
   * before `today`. Used by the daily auto-archive cron to sweep up
   * planned leavers whose leaveDate has since become past — the
   * on-save auto-archive fixes profiles the admin opens; this fills
   * the gap for the ones nobody visited.
   *
   * Returns `employeeProfileId + leaveDate + existing archiveReason`
   * (so the cron can preserve the admin's original reason if they
   * had set one). Ordered by leaveDate ASC so cron log reads
   * chronologically.
   */
  async listPastLeaveDateActiveProfiles(today: Date): Promise<
    Array<{
      employeeProfileId: string
      leaveDate: Date
      archiveReason: string | null
    }>
  > {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.payrollProfile.findMany({
      where: {
        isArchived: false,
        leaveDate: { lt: today, not: null },
      },
      select: {
        employeeProfileId: true,
        leaveDate: true,
        archiveReason: true,
      },
      orderBy: { leaveDate: "asc" },
    })
    return rows
      .filter((r): r is typeof r & { leaveDate: Date } => r.leaveDate !== null)
      .map((r) => ({
        employeeProfileId: r.employeeProfileId,
        leaveDate: r.leaveDate,
        archiveReason: r.archiveReason,
      }))
  },

  async archive(
    employeeProfileId: string,
    reason: string,
    leaveDate: Date,
  ): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    await prisma.payrollProfile.update({
      where: { employeeProfileId },
      data: {
        isArchived: true,
        archivedAt: new Date(),
        archiveReason: reason,
        leaveDate,
      },
    })
  },

  /**
   * Restore an archived employee to active payroll. Also clears
   * `leaveDate` since they're no longer leaving — otherwise the next
   * run's proration would still think they're departing.
   *
   * Optional rehire-with-other-employer path: when the admin says the
   * employee worked elsewhere during the absence, we persist the TP3
   * carryover (total YTD figures) plus
   * `prevIncludesPriorThisOrgPeriod = true` so the run service
   * subtracts this org's existing payslip YTD before adding to PCB.
   */
  async unarchive(
    employeeProfileId: string,
    rehireCarryover?: {
      prevEmploymentYear: number
      prevRemuneration: number
      prevEpf: number
      prevPcb: number
      prevZakat: number
    } | null,
  ): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")
    const data: Record<string, unknown> = {
      isArchived: false,
      archivedAt: null,
      archiveReason: null,
      leaveDate: null,
    }
    if (rehireCarryover) {
      data.prevEmploymentYear = rehireCarryover.prevEmploymentYear
      data.prevRemuneration = rehireCarryover.prevRemuneration
      data.prevEpf = rehireCarryover.prevEpf
      data.prevPcb = rehireCarryover.prevPcb
      data.prevZakat = rehireCarryover.prevZakat
      data.prevIncludesPriorThisOrgPeriod = true
    } else {
      // "No, didn't work elsewhere" — clear any stale carryover so the
      // restored employee starts fresh. PCB will use only this org's
      // existing YTD from submitted payslips.
      data.prevIncludesPriorThisOrgPeriod = false
    }
    await prisma.payrollProfile.update({
      where: { employeeProfileId },
      data,
    })
  },
}

// ─── Mappers ──────────────────────────────────────────────────────────────

/**
 * Project a Prisma `PayrollProfile` row into the app-friendly
 * `PayrollProfileData` shape. Hides Decimal + Json quirks from callers.
 *
 * The Prisma row type is `any` here because the generated types pull in
 * Decimal wrappers and JsonValue that complicate the signature without
 * benefit — the mapper is the only consumer of the raw row.
 */
function mapPayrollProfile(row: any): PayrollProfileData {
  return {
    id: row.id,
    employeeProfileId: row.employeeProfileId,

    phone: row.phone ?? null,
    alternateEmail: row.alternateEmail ?? null,
    gender: row.gender ?? null,
    dateOfBirth: row.dateOfBirth ? row.dateOfBirth.toISOString().slice(0, 10) : null,
    nationality: row.nationality ?? null,
    race: row.race ?? null,
    hasPr: row.hasPr,
    idType: row.idType ?? null,
    idNumber: row.idNumber ?? null,
    maritalStatus: row.maritalStatus ?? null,
    isResident: row.isResident,
    isOku: row.isOku,

    spouseWorking: row.spouseWorking ?? null,
    spouseDisabled: row.spouseDisabled ?? null,
    spousePcbNumber: row.spousePcbNumber ?? null,
    spouseIdNumber: row.spouseIdNumber ?? null,

    addressLine1: row.addressLine1 ?? null,
    addressLine2: row.addressLine2 ?? null,
    addressLine3: row.addressLine3 ?? null,
    city: row.city ?? null,
    postcode: row.postcode ?? null,
    state: row.state ?? null,

    emergencyContactName: row.emergencyContactName ?? null,
    emergencyContactPhone: row.emergencyContactPhone ?? null,
    emergencyContactRelation: row.emergencyContactRelation ?? null,

    childRelief: parseChildReliefJson(row.childRelief),

    prevEmploymentYear: row.prevEmploymentYear ?? null,
    prevRemuneration:
      row.prevRemuneration === null ? null : toNumber(row.prevRemuneration, 0),
    prevEpf: row.prevEpf === null ? null : toNumber(row.prevEpf, 0),
    prevPcb: row.prevPcb === null ? null : toNumber(row.prevPcb, 0),
    prevZakat: row.prevZakat === null ? null : toNumber(row.prevZakat, 0),
    prevAllowableDeductions:
      row.prevAllowableDeductions === null
        ? null
        : toNumber(row.prevAllowableDeductions, 0),
    prevIncludesPriorThisOrgPeriod: row.prevIncludesPriorThisOrgPeriod ?? false,

    contributeToEpf: row.contributeToEpf,
    epfMemberBefore1998: row.epfMemberBefore1998,
    epfNumber: row.epfNumber ?? null,
    epfEmployeeRate: toNumber(row.epfEmployeeRate, 11),
    epfEmployeeVoluntary: toNumber(row.epfEmployeeVoluntary, 0),
    epfEmployerVoluntary: toNumber(row.epfEmployerVoluntary, 0),

    socsoNumber: row.socsoNumber ?? null,
    socsoScheme: row.socsoScheme ?? null,
    contributeToEis: row.contributeToEis,
    contributeToSkbbk: row.contributeToSkbbk,
    incomeTaxNumber: row.incomeTaxNumber ?? null,
    pcbBorneByEmployer: row.pcbBorneByEmployer,
    ssfwNumber: row.ssfwNumber ?? null,

    paymentMethod: row.paymentMethod,
    bankName: row.bankName ?? null,
    bankAccountHolderName: row.bankAccountHolderName ?? null,
    bankAccountNumber: row.bankAccountNumber ?? null,

    salaryType: row.salaryType,
    monthlySalary:
      row.monthlySalary === null ? null : toNumber(row.monthlySalary, 0),
    hourlyRate: row.hourlyRate === null ? null : toNumber(row.hourlyRate, 0),
    fixedAllowances: parseFixedAllowancesJson(row.fixedAllowances),

    joinDate: row.joinDate ? row.joinDate.toISOString().slice(0, 10) : null,
    temporaryReviewDate: row.temporaryReviewDate
      ? row.temporaryReviewDate.toISOString().slice(0, 10)
      : null,
    leaveDate: row.leaveDate ? row.leaveDate.toISOString().slice(0, 10) : null,
    archiveReason: row.archiveReason ?? null,
    reportedToLhdn: row.reportedToLhdn,

    department: row.department ?? null,
    location: row.location ?? null,
    workSchedule: row.workSchedule ?? null,
    payrollPolicy: row.payrollPolicy ?? null,
    payrollCycle: row.payrollCycle ?? null,

    leaveEntitlement: parseLeaveEntitlementJson(row.leaveEntitlement),
    payrollDocuments: parsePayrollDocumentsJson(row.payrollDocuments),

    isArchived: row.isArchived,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,

    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Translate the app's `Partial<PayrollProfileData>` patch into the
 * Prisma-shaped object for create/update. Dates come in as ISO yyyy-mm-dd
 * strings; Prisma wants `Date` objects.
 */
function toPrismaUpsertData(
  patch: Partial<Omit<PayrollProfileData, "id" | "employeeProfileId" | "createdAt" | "updatedAt">>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  const copy = <K extends keyof typeof patch>(k: K) => {
    if (patch[k] !== undefined) out[k as string] = patch[k]
  }
  const copyDate = <K extends keyof typeof patch>(k: K) => {
    if (patch[k] === undefined) return
    const v = patch[k] as unknown
    out[k as string] = v === null ? null : new Date(String(v))
  }

  copy("phone")
  copy("alternateEmail")
  copy("gender")
  copyDate("dateOfBirth")
  copy("nationality")
  copy("race")
  copy("hasPr")
  copy("idType")
  copy("idNumber")
  copy("maritalStatus")
  copy("isResident")
  copy("isOku")

  copy("spouseWorking")
  copy("spouseDisabled")
  copy("spousePcbNumber")
  copy("spouseIdNumber")

  copy("addressLine1")
  copy("addressLine2")
  copy("addressLine3")
  copy("city")
  copy("postcode")
  copy("state")

  copy("emergencyContactName")
  copy("emergencyContactPhone")
  copy("emergencyContactRelation")

  if (patch.childRelief !== undefined) {
    out.childRelief = patch.childRelief
  }

  copy("prevEmploymentYear")
  copy("prevRemuneration")
  copy("prevEpf")
  copy("prevPcb")
  copy("prevZakat")
  copy("prevAllowableDeductions")
  copy("prevIncludesPriorThisOrgPeriod")

  copy("contributeToEpf")
  copy("epfMemberBefore1998")
  copy("epfNumber")
  copy("epfEmployeeRate")
  copy("epfEmployeeVoluntary")
  copy("epfEmployerVoluntary")

  copy("socsoNumber")
  copy("socsoScheme")
  copy("contributeToEis")
  copy("contributeToSkbbk")
  copy("incomeTaxNumber")
  copy("pcbBorneByEmployer")
  copy("ssfwNumber")

  copy("paymentMethod")
  copy("bankName")
  copy("bankAccountHolderName")
  copy("bankAccountNumber")

  copy("salaryType")
  copy("monthlySalary")
  copy("hourlyRate")
  if (patch.fixedAllowances !== undefined) {
    out.fixedAllowances = patch.fixedAllowances
  }

  copyDate("joinDate")
  copyDate("temporaryReviewDate")
  copyDate("leaveDate")
  copy("archiveReason")
  copy("reportedToLhdn")

  copy("department")
  copy("location")
  copy("workSchedule")
  copy("payrollPolicy")
  copy("payrollCycle")

  if (patch.leaveEntitlement !== undefined) {
    out.leaveEntitlement = patch.leaveEntitlement
  }
  if (patch.payrollDocuments !== undefined) {
    out.payrollDocuments = patch.payrollDocuments
  }

  copy("isArchived")
  if (patch.archivedAt !== undefined) {
    out.archivedAt =
      patch.archivedAt === null ? null : new Date(patch.archivedAt)
  }

  return out
}

// ─── JSON parsers (defensive: bad data → empty arrays, never throws) ─────

function parseChildReliefJson(raw: unknown): ChildRelief[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null
      const e = entry as Record<string, unknown>
      // `age` is no longer part of the model (July 2026 simplification)
      // but historical rows still carry it. Drop it silently on read.
      return {
        abilityStatus:
          e.abilityStatus === "DISABLED" ? "DISABLED" : "NORMAL",
        // Legacy values (NONE / PRESCHOOL / PRIMARY / SECONDARY / HIGHER_ED)
        // are mapped to the current set inside normaliseChildStudyingLevel.
        currentlyStudying: normaliseChildStudyingLevel(
          typeof e.currentlyStudying === "string" ? e.currentlyStudying : null,
        ),
        pcbDeduction:
          (typeof e.pcbDeduction === "string" &&
          ["FULL", "HALF", "NONE"].includes(e.pcbDeduction)
            ? e.pcbDeduction
            : "NONE") as ChildRelief["pcbDeduction"],
      } satisfies ChildRelief
    })
    .filter((x): x is ChildRelief => x !== null)
}

function parseFixedAllowancesJson(raw: unknown): FixedAllowance[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null
      const e = entry as Record<string, unknown>
      const amount =
        typeof e.amount === "number" ? e.amount : Number(e.amount)
      const categoryRaw =
        typeof e.category === "string" ? e.category : "allowance_standard"
      const category = payrollAdjustmentCategories.includes(categoryRaw as never)
        ? (categoryRaw as FixedAllowance["category"])
        : "allowance_standard"
      const name =
        typeof e.name === "string"
          ? e.name.trim() || PAYROLL_ADJUSTMENT_CATEGORY_META[category].label
          : PAYROLL_ADJUSTMENT_CATEGORY_META[category].label
      // Drop zero/negative entries — meaningless for payroll, and
      // sanitises the legacy "phantom row on every save" bug where
      // empty form slots were persisted as
      // `{ category: "allowance_standard", name: "Standard Allowance",
      //   amount: 0 }`. Saving the Employment tab once after this fix
      // permanently cleans the column.
      if (!Number.isFinite(amount) || amount <= 0) return null
      // LHDN AR override — preserved on read so the checkbox renders
      // its persisted state on the Employment tab. The mapper was
      // previously dropping this field, so a ticked checkbox would
      // round-trip back as unchecked after save, even though the JSON
      // column had the value stored correctly. Pre-Phase-19 rows have
      // no `treatAsRecurring` → defaults to undefined (= unchecked,
      // matching the old behaviour).
      const allowance: FixedAllowance = {
        category,
        name,
        amount,
      }
      if (e.treatAsRecurring === true) allowance.treatAsRecurring = true
      return allowance
    })
    .filter((x): x is FixedAllowance => x !== null)
}

function parseLeaveEntitlementJson(raw: unknown): LeaveEntitlement[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null
      const e = entry as Record<string, unknown>
      const type = typeof e.type === "string" ? e.type : ""
      const days = typeof e.days === "number" ? e.days : Number(e.days)
      if (!type || !Number.isFinite(days)) return null
      return { type, days } satisfies LeaveEntitlement
    })
    .filter((x): x is LeaveEntitlement => x !== null)
}

function parsePayrollDocumentsJson(raw: unknown): PayrollDocument[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null
      const e = entry as Record<string, unknown>
      const id = typeof e.id === "string" ? e.id : ""
      const name = typeof e.name === "string" ? e.name : ""
      const mimeType = typeof e.mimeType === "string" ? e.mimeType : ""
      const sizeBytes =
        typeof e.sizeBytes === "number"
          ? e.sizeBytes
          : Number(e.sizeBytes)
      const url = typeof e.url === "string" ? e.url : ""
      const uploadedAt =
        typeof e.uploadedAt === "string" ? e.uploadedAt : ""
      if (!id || !name || !url) return null
      return {
        id,
        name,
        mimeType,
        sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
        url,
        uploadedAt,
      } satisfies PayrollDocument
    })
    .filter((x): x is PayrollDocument => x !== null)
}
