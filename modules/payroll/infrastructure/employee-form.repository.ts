import "server-only"

import { toNumber } from "@/lib/decimal"
import { sumAllowances } from "@/modules/payroll/domain/calc"
import type { ChildRelief, FixedAllowance } from "@/modules/payroll/domain/models"
import { reliefForChild } from "@/modules/payroll/domain/pcb"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"

/**
 * Per-employee data loader for the LHDN forms surfaced on the
 * payroll-employee detail page (PCB2(II), CP22, CP22A, CP21, TP3).
 *
 * Sibling of `loadAnnualPayrollPayload` in `annual-shared.ts` — the
 * annual loader aggregates ALL employees of an org by year; this one
 * aggregates ONE employee, with the per-month granularity PCB2(II)
 * needs.
 */

export type EmployeeFormPayload = {
  /// Identity + employer header
  organizationId: string
  organizationName: string
  /// Employer info from PayrollCompanyInfo (may be partial — the EA
  /// loader treats it the same way; renderers fall back to "—").
  employer: {
    employerName: string | null
    employerTin: string | null
    registrationNo: string | null
    /// Joined address. Address lines + postcode + city + state on
    /// PayrollCompanyInfo are nullable, so the loader assembles
    /// whatever pieces are present.
    fullAddress: string | null
    phone: string | null
    email: string | null
    declarantName: string | null
    declarantPosition: string | null
    declarantIdNumber: string | null
  }
  employee: {
    userId: string
    employeeProfileId: string
    payrollProfileId: string | null
    name: string
    employeeCode: string
    jobTitle: string | null
    /// IC / passport — whichever was filled. idType disambiguates.
    idNumber: string | null
    idType: "NRIC" | "PASSPORT" | "ARMY_NO" | "POLICE_NO" | null
    incomeTaxNumber: string | null
    epfNumber: string | null
    socsoNumber: string | null
    nationality: string | null
    gender: "MALE" | "FEMALE" | "OTHER" | null
    dateOfBirth: Date | null
    maritalStatus:
      | "SINGLE"
      | "MARRIED"
      | "DIVORCED"
      | "WIDOWED"
      | "SEPARATED"
      | null
    phone: string | null
    alternateEmail: string | null
    email: string
    addressLine1: string | null
    addressLine2: string | null
    addressLine3: string | null
    postcode: string | null
    city: string | null
    state: string | null
    joinDate: Date | null
    leaveDate: Date | null
    isArchived: boolean
    archivedAt: Date | null
    archiveReason: string | null
    /// Spouse fields used by CP22 / CP22A.
    spouseWorking: boolean | null
    spouseIdNumber: string | null
    spousePcbNumber: string | null
    /// Salary type drives whether CP22 monthly-remuneration shows
    /// monthlySalary vs an hourly estimate.
    salaryType: "MONTHLY" | "HOURLY" | null
    monthlySalary: number | null
    hourlyRate: number | null
    /// Whether PCB is borne by the employer rather than withheld from
    /// the employee. Drives the CP22A "Tax borne by employer" toggle.
    pcbBorneByEmployer: boolean
    /// Sum of fixed monthly cash allowances from the JSON column.
    /// Used in CP22 D4 / CP22A B6 ("Cash allowances incl. tax borne
    /// by employer"). Null when no fixed allowances are configured.
    fixedAllowancesTotal: number | null
    /// Qualifying-children count (excludes children with
    /// pcbDeduction = NONE). Drives CP22A line 13a.
    qualifyingChildren: number
    /// Annual child-relief amount (RM) computed via the PCB helper.
    /// Drives CP22A line 13b. 0 when no qualifying children.
    annualChildRelief: number
    /// Carry-over figures from previous employment in the same tax
    /// year. Used in CP22 Section E and as TP3 hints. Employer name +
    /// address still admin-entered (not stored on PayrollProfile).
    prevEmploymentYear: number | null
    prevRemuneration: number | null
    prevEpf: number | null
  }
  /// Per-month PCB / CP38 / zakat from this employee's payslips in the
  /// requested calendar year. Months without a SUBMITTED run are
  /// represented as `null` so the PCB2(II) table prints a blank row.
  /// 12 entries, January (index 0) → December (index 11).
  perMonth: Array<EmployeeMonthPcb | null>
  /// Year covered by `perMonth`. Same year requested by the caller.
  year: number
  /// Year-to-date sums across submitted payslips for the year. Used by
  /// TP3 + the YTD-style sections of CP22A / CP21.
  ytd: {
    grossSalary: number
    bonusAndCommission: number
    totalBik: number
    totalPcb: number
    totalZakat: number
    totalEpfEmployee: number
    totalSocsoEmployee: number
    totalEisEmployee: number
  }
}

export type EmployeeMonthPcb = {
  month: number // 1..12
  /// MTD = monthly tax deduction. The standard PCB withholding.
  mtd: number
  /// CP38 = LHDN-directed additional deduction. Not yet captured by
  /// the calc engine — always 0 in v1, but kept as a column so the
  /// schema doesn't need to change once it's wired up.
  cp38: number
  /// Zakat-via-payroll for the month. Shown in TP3 + handy for the
  /// per-month panel below the PCB2(II) table.
  zakat: number
}

/**
 * Load everything the LHDN-form renderers need for ONE employee.
 *
 * `year` is the calendar year of interest:
 *   - PCB2(II) uses it for the monthly MTD/CP38 table
 *   - TP3 uses it for the YTD section
 *   - CP22 ignores it (forward-looking new-hire form)
 *   - CP22A / CP21 also use it for the YTD section
 *
 * Returns null when the employee doesn't belong to the org or the DB
 * isn't reachable. Caller handles the friendly error.
 */
export async function loadEmployeeFormPayload(input: {
  organizationId: string
  userId: string
  year: number
}): Promise<EmployeeFormPayload | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  // Tug in the org, company info, the user with employee+payroll
  // profile, and every SUBMITTED-run payslip for this employee in the
  // requested year — all in parallel.
  const [org, companyInfo, user, runs] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { name: true },
    }),
    prisma.payrollCompanyInfo.findUnique({
      where: { organizationId: input.organizationId },
    }),
    prisma.user.findFirst({
      where: { id: input.userId, organizationId: input.organizationId },
      select: {
        id: true,
        name: true,
        email: true,
        employeeProfiles: {
          where: { organizationId: input.organizationId },
          select: {
            id: true,
            employeeId: true,
            jobTitle: true,
            payrollProfile: true,
          },
          take: 1,
        },
      },
    }),
    prisma.payrollRun.findMany({
      where: {
        organizationId: input.organizationId,
        periodYear: input.year,
        status: "SUBMITTED",
        payslips: {
          some: {
            employeeProfile: { user: { id: input.userId } },
          },
        },
      },
      select: {
        periodMonth: true,
        payslips: {
          where: { employeeProfile: { user: { id: input.userId } } },
          select: {
            id: true,
            employeeProfileId: true,
            payrollProfileId: true,
            grossPay: true,
            totalBenefitsInKind: true,
            epfEmployee: true,
            socsoEmployee: true,
            eisEmployee: true,
            pcb: true,
            voluntaryPcb: true,
            zakat: true,
            lineItems: { select: { category: true, amount: true } },
          },
        },
      },
    }),
  ])

  const ep = user?.employeeProfiles[0]
  if (!user || !ep) return null
  const pp = ep.payrollProfile

  // Compute child-relief aggregates from the JSON column. Mirrors the
  // EA loader (`annual-shared.ts`) — children with `pcbDeduction = NONE`
  // don't count toward the qualifying count.
  let qualifyingChildren = 0
  let annualChildRelief = 0
  if (pp && Array.isArray(pp.childRelief)) {
    const children = pp.childRelief as ChildRelief[]
    for (const c of children) {
      if (!c || typeof c !== "object") continue
      if (c.pcbDeduction === "NONE") continue
      qualifyingChildren += 1
      annualChildRelief += reliefForChild(c)
    }
  }

  // Sum recurring positive earnings from `fixedAllowances` JSON via
  // the canonical helper. Same source the calc engine uses for monthly
  // pay, so the figure matches what payslips actually pay out.
  let fixedAllowancesTotal: number | null = null
  if (pp && Array.isArray(pp.fixedAllowances)) {
    const items = pp.fixedAllowances as FixedAllowance[]
    if (items.length > 0) {
      fixedAllowancesTotal = sumAllowances(items)
    }
  }

  // Build the per-month MTD/CP38/zakat array. Initialise with nulls so
  // months without a submitted run print as blank rows in the PCB2(II)
  // table (rather than "0.00", which could mislead an auditor).
  const perMonth: Array<EmployeeMonthPcb | null> = Array.from(
    { length: 12 },
    () => null,
  )
  const ytd = {
    grossSalary: 0,
    bonusAndCommission: 0,
    totalBik: 0,
    totalPcb: 0,
    totalZakat: 0,
    totalEpfEmployee: 0,
    totalSocsoEmployee: 0,
    totalEisEmployee: 0,
  }

  for (const run of runs) {
    // PCB2(II) is one row per month; sum across the (typically one)
    // payslip for the employee in that month, just in case an off-
    // cycle adjustment payslip lives on the same run.
    let monthMtd = 0
    let monthCp38 = 0
    let monthZakat = 0
    for (const p of run.payslips) {
      const gross = toNumber(p.grossPay, 0) ?? 0
      const bik = toNumber(p.totalBenefitsInKind, 0) ?? 0
      const epfE = toNumber(p.epfEmployee, 0) ?? 0
      const socsoE = toNumber(p.socsoEmployee, 0) ?? 0
      const eisE = toNumber(p.eisEmployee, 0) ?? 0
      const pcb = toNumber(p.pcb, 0) ?? 0
      // Additional PCB (Employment Income) is remitted as part of the
      // standard MTD (folded into the CP39 standard PCB field), so include
      // it in the PCB2(II) monthly MTD + YTD total so the statement matches
      // the upload file. It is NOT part of the LHDN MTD *formula* — see
      // getYtdForEmployee, where next month's baseline still excludes it.
      const voluntaryPcb = toNumber(p.voluntaryPcb, 0) ?? 0
      const zakat = toNumber(p.zakat, 0) ?? 0

      monthMtd += pcb + voluntaryPcb
      monthZakat += zakat
      // CP38 is not yet stored on the payslip; placeholder always 0.
      monthCp38 += 0

      ytd.grossSalary += gross
      ytd.totalBik += bik
      ytd.totalEpfEmployee += epfE
      ytd.totalSocsoEmployee += socsoE
      ytd.totalEisEmployee += eisE
      ytd.totalPcb += pcb + voluntaryPcb
      ytd.totalZakat += zakat

      // Bonus / commission / fees / arrears / director fee — sum from
      // line items. Same categories the EA loader uses.
      for (const li of p.lineItems) {
        if (
          li.category === "wages_bonus_annual" ||
          li.category === "wages_bonus_non_annual" ||
          li.category === "wages_commission" ||
          li.category === "wages_incentive" ||
          li.category === "wages_arrears" ||
          li.category === "wages_director_fee" ||
          li.category === "wages_gratuity" ||
          li.category === "wages_leave_pay" ||
          li.category === "wages_ex_gratia" ||
          li.category === "wages_compensation_loss_employment"
        ) {
          ytd.bonusAndCommission += toNumber(li.amount, 0) ?? 0
        }
      }
    }
    perMonth[run.periodMonth - 1] = {
      month: run.periodMonth,
      mtd: monthMtd,
      cp38: monthCp38,
      zakat: monthZakat,
    }
  }

  // Assemble the employer block from PayrollCompanyInfo. Each field
  // could be null — renderers fall back to "—".
  const addressParts = [
    companyInfo?.addressLine1,
    companyInfo?.addressLine2,
    [companyInfo?.postcode, companyInfo?.city]
      .filter(Boolean)
      .join(" ")
      .trim() || null,
    companyInfo?.state,
  ].filter((p): p is string => !!p && p.trim().length > 0)

  return {
    organizationId: input.organizationId,
    organizationName: org?.name ?? "",
    employer: {
      employerName: companyInfo?.employerName ?? null,
      employerTin: companyInfo?.employerTin ?? null,
      registrationNo: companyInfo?.registrationNo ?? null,
      fullAddress: addressParts.length > 0 ? addressParts.join(", ") : null,
      phone: companyInfo?.phone ?? null,
      email: companyInfo?.email ?? null,
      declarantName: companyInfo?.declarantName ?? null,
      declarantPosition: companyInfo?.declarantPosition ?? null,
      declarantIdNumber: companyInfo?.declarantIdNumber ?? null,
    },
    employee: {
      userId: user.id,
      employeeProfileId: ep.id,
      payrollProfileId: pp?.id ?? null,
      name: user.name,
      employeeCode: ep.employeeId,
      jobTitle: ep.jobTitle ?? null,
      idNumber: pp?.idNumber ?? null,
      idType:
        (pp?.idType as EmployeeFormPayload["employee"]["idType"]) ?? null,
      incomeTaxNumber: pp?.incomeTaxNumber ?? null,
      epfNumber: pp?.epfNumber ?? null,
      socsoNumber: pp?.socsoNumber ?? null,
      nationality: pp?.nationality ?? null,
      gender:
        (pp?.gender as EmployeeFormPayload["employee"]["gender"]) ?? null,
      dateOfBirth: pp?.dateOfBirth ?? null,
      maritalStatus:
        (pp?.maritalStatus as EmployeeFormPayload["employee"]["maritalStatus"]) ??
        null,
      phone: pp?.phone ?? null,
      alternateEmail: pp?.alternateEmail ?? null,
      email: user.email,
      addressLine1: pp?.addressLine1 ?? null,
      addressLine2: pp?.addressLine2 ?? null,
      addressLine3: pp?.addressLine3 ?? null,
      postcode: pp?.postcode ?? null,
      city: pp?.city ?? null,
      state: pp?.state ?? null,
      joinDate: pp?.joinDate ?? null,
      leaveDate: pp?.leaveDate ?? null,
      isArchived: pp?.isArchived ?? false,
      archivedAt: pp?.archivedAt ?? null,
      archiveReason: pp?.archiveReason ?? null,
      spouseWorking: pp?.spouseWorking ?? null,
      spouseIdNumber: pp?.spouseIdNumber ?? null,
      spousePcbNumber: pp?.spousePcbNumber ?? null,
      salaryType:
        (pp?.salaryType as EmployeeFormPayload["employee"]["salaryType"]) ??
        null,
      monthlySalary: toNumber(pp?.monthlySalary, 0) ?? null,
      hourlyRate: toNumber(pp?.hourlyRate, 0) ?? null,
      pcbBorneByEmployer: pp?.pcbBorneByEmployer ?? false,
      fixedAllowancesTotal,
      qualifyingChildren,
      annualChildRelief,
      prevEmploymentYear: pp?.prevEmploymentYear ?? null,
      prevRemuneration: toNumber(pp?.prevRemuneration, 0) ?? null,
      prevEpf: toNumber(pp?.prevEpf, 0) ?? null,
    },
    perMonth,
    year: input.year,
    ytd,
  }
}
