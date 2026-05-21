import "server-only"

import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { toNumber } from "@/lib/decimal"
import type { ChildRelief } from "@/modules/payroll/domain/models"
import { reliefForChild } from "@/modules/payroll/domain/pcb"
import type { PayrollCompanyInfoData } from "@/modules/payroll/domain/settings"

/**
 * Aggregated per-employee figures for the calendar year — used by the
 * Form EA, Form E + CP8D, and CP8D TXT generators.
 *
 * `EA-relevant` columns mirror the EA form sections:
 *   - B (income): gross, bonus/commission, BIK
 *   - D (deductions): PCB, zakat, CP38
 *   - E (employee contributions): EPF, SOCSO/EIS
 */
export type AnnualEmployeeAggregate = {
  // Identity
  employeeProfileId: string
  payrollProfileId: string
  userId: string
  employeeName: string
  employeeCode: string
  jobTitle: string | null

  // Statutory numbers
  idNumber: string | null
  idType: "IC" | "PASSPORT" | "OTHER" | null
  epfNumber: string | null
  socsoNumber: string | null
  ssfwNumber: string | null
  incomeTaxNumber: string | null
  nationality: string | null
  hasPr: boolean
  isResident: boolean
  gender: "MALE" | "FEMALE" | "OTHER" | null
  maritalStatus:
    | "SINGLE"
    | "MARRIED"
    | "DIVORCED"
    | "WIDOWED"
    | "SEPARATED"
    | null
  /// Spouse working flag — drives CP8D tax category (1/2/3).
  spouseWorking: boolean | null
  /// Number of qualifying children — drives CP8D child relief column.
  /// "Qualifying" = children whose `pcbDeduction` is FULL or HALF
  /// (NONE is excluded — those children are tracked on the profile but
  /// not claimed for tax relief).
  qualifyingChildren: number
  /// Annual child-relief amount in RM, computed from each child's age,
  /// study stage, ability status, and PCB share via the canonical
  /// `reliefForChild` helper in `modules/payroll/domain/pcb.ts`. Used
  /// in the CP8D "Annual Child Relief" column and the EA form.
  annualChildRelief: number
  /// PCB borne by employer toggle. CP8D col 5: 1=Yes, 2=No.
  pcbBorneByEmployer: boolean

  // Aggregated yearly figures (sum across SUBMITTED runs)
  grossSalary: number
  /// Bonus / commission / fees / arrears / director fee — sum of
  /// PayslipLineItem rows whose category meta marks them as
  /// "additional remuneration".
  bonusAndCommission: number
  /// Sum of BIK / perquisite line items.
  totalBik: number
  /// Subject to PCB for the year — total PCB withheld.
  totalPcb: number
  /// CP38 (court-ordered tax deductions). Not yet captured by calc —
  /// always zero in v1.
  totalCp38: number
  /// Zakat (payroll-deducted).
  totalZakat: number
  totalEpfEmployee: number
  totalSocsoEmployee: number
  totalEisEmployee: number
}

/**
 * Top-level payload returned by `loadAnnualPayrollPayload`. Wraps
 * employer info + the aggregated employee rows.
 */
export type AnnualPayrollPayload = {
  organizationId: string
  organizationName: string
  year: number
  companyInfo: PayrollCompanyInfoData | null
  /// Numeric employer reference (E-number with `E` + dashes stripped),
  /// used as the M/P file prefix. May be empty if not configured —
  /// generators throw with a helpful message in that case.
  employerNo: string
  employees: AnnualEmployeeAggregate[]
}

/**
 * Aggregate every SUBMITTED PayrollRun for `(organizationId, year)`
 * into one row per employee. Iterates payslips once and sums the
 * relevant columns into the `AnnualEmployeeAggregate` shape.
 */
export async function loadAnnualPayrollPayload(input: {
  organizationId: string
  year: number
}): Promise<AnnualPayrollPayload | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  const [org, companyInfo, runs] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { name: true },
    }),
    prisma.payrollCompanyInfo.findUnique({
      where: { organizationId: input.organizationId },
    }),
    prisma.payrollRun.findMany({
      where: {
        organizationId: input.organizationId,
        periodYear: input.year,
        status: "SUBMITTED",
      },
      select: {
        id: true,
        periodMonth: true,
        payslips: {
          select: {
            id: true,
            employeeProfileId: true,
            payrollProfileId: true,
            snapshotName: true,
            snapshotEmployeeId: true,
            snapshotPosition: true,
            snapshotIsResident: true,
            snapshotNationality: true,
            grossPay: true,
            totalBenefitsInKind: true,
            epfEmployee: true,
            socsoEmployee: true,
            eisEmployee: true,
            pcb: true,
            zakat: true,
            lineItems: {
              select: { category: true, amount: true },
            },
          },
        },
      },
    }),
  ])

  // Build the per-employee aggregate. Use payrollProfileId as the key
  // so we group correctly even if the user gets renamed mid-year.
  const aggregates = new Map<string, AnnualEmployeeAggregate>()

  // Sum across every payslip on every SUBMITTED run in the year.
  for (const run of runs) {
    for (const p of run.payslips) {
      const profileKey = p.payrollProfileId ?? p.employeeProfileId
      let agg = aggregates.get(profileKey)
      if (!agg) {
        agg = blankAggregate({
          employeeProfileId: p.employeeProfileId,
          payrollProfileId: p.payrollProfileId ?? "",
          userId: "", // filled below
          employeeName: p.snapshotName,
          employeeCode: p.snapshotEmployeeId,
          jobTitle: p.snapshotPosition ?? null,
          nationality: p.snapshotNationality ?? null,
          isResident: p.snapshotIsResident,
        })
        aggregates.set(profileKey, agg)
      }

      const gross = toNumber(p.grossPay, 0) ?? 0
      const bik = toNumber(p.totalBenefitsInKind, 0) ?? 0
      const epfE = toNumber(p.epfEmployee, 0) ?? 0
      const socsoE = toNumber(p.socsoEmployee, 0) ?? 0
      const eisE = toNumber(p.eisEmployee, 0) ?? 0
      const pcb = toNumber(p.pcb, 0) ?? 0
      const zakat = toNumber(p.zakat, 0) ?? 0

      agg.grossSalary += gross
      agg.totalBik += bik
      agg.totalEpfEmployee += epfE
      agg.totalSocsoEmployee += socsoE
      agg.totalEisEmployee += eisE
      agg.totalPcb += pcb
      agg.totalZakat += zakat

      // Bonus / commission / fees / arrears / director fee / gratuity
      // — sum from line items whose category is flagged as
      // "additional remuneration" in the metadata. These are the cash
      // one-off payments that LHDN Form EA reports separately from
      // recurring salary.
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
          agg.bonusAndCommission += toNumber(li.amount, 0) ?? 0
        }
      }
    }
  }

  // Pull the live PayrollProfile rows for every employee we touched,
  // for statutory numbers + demographics + child relief.
  const profileIds = Array.from(aggregates.keys()).filter(
    (k) => k && k.length > 0,
  )
  const profiles =
    profileIds.length === 0
      ? []
      : await prisma.payrollProfile.findMany({
          where: { id: { in: profileIds } },
          select: {
            id: true,
            idType: true,
            idNumber: true,
            epfNumber: true,
            socsoNumber: true,
            ssfwNumber: true,
            incomeTaxNumber: true,
            nationality: true,
            hasPr: true,
            isResident: true,
            gender: true,
            maritalStatus: true,
            spouseWorking: true,
            pcbBorneByEmployer: true,
            childRelief: true,
            employeeProfile: {
              select: {
                user: { select: { id: true } },
              },
            },
          },
        })

  const profileByPid = new Map(profiles.map((p) => [p.id, p]))

  for (const [pid, agg] of aggregates.entries()) {
    const profile = profileByPid.get(pid)
    if (!profile) continue

    agg.idNumber = profile.idNumber ?? null
    agg.idType =
      (profile.idType as AnnualEmployeeAggregate["idType"]) ?? null
    agg.epfNumber = profile.epfNumber ?? null
    agg.socsoNumber = profile.socsoNumber ?? null
    agg.ssfwNumber = profile.ssfwNumber ?? null
    agg.incomeTaxNumber = profile.incomeTaxNumber ?? null
    agg.nationality = profile.nationality ?? agg.nationality
    agg.hasPr = profile.hasPr
    agg.isResident = profile.isResident
    agg.gender =
      (profile.gender as AnnualEmployeeAggregate["gender"]) ?? null
    agg.maritalStatus =
      (profile.maritalStatus as AnnualEmployeeAggregate["maritalStatus"]) ??
      null
    agg.spouseWorking = profile.spouseWorking
    agg.pcbBorneByEmployer = profile.pcbBorneByEmployer
    agg.userId = profile.employeeProfile?.user.id ?? ""

    // childRelief is a JSON array — coerce, compute per-child relief
    // amounts via the canonical PCB helper, and roll up. Children with
    // `pcbDeduction === "NONE"` don't count toward the CP8D qualifying
    // count (we still track them on the profile, but they aren't
    // claimed for tax relief).
    if (Array.isArray(profile.childRelief)) {
      const children = profile.childRelief as ChildRelief[]
      let qualifying = 0
      let reliefTotal = 0
      for (const c of children) {
        if (!c || typeof c !== "object") continue
        if (c.pcbDeduction === "NONE") continue
        qualifying += 1
        reliefTotal += reliefForChild(c)
      }
      agg.qualifyingChildren = qualifying
      agg.annualChildRelief = reliefTotal
    }
  }

  // Build the company-info data object (Prisma row → domain type).
  const companyInfoData: PayrollCompanyInfoData | null = companyInfo
    ? {
        id: companyInfo.id,
        organizationId: companyInfo.organizationId,
        employerName: companyInfo.employerName ?? null,
        employerTin: companyInfo.employerTin ?? null,
        registrationNo: companyInfo.registrationNo ?? null,
        referenceType: companyInfo.referenceType ?? null,
        referenceNo: companyInfo.referenceNo ?? null,
        employerCategory: companyInfo.employerCategory ?? null,
        employerStatus: companyInfo.employerStatus ?? null,
        cp8dFurnishType: companyInfo.cp8dFurnishType ?? null,
        perkesoEmployerCode: companyInfo.perkesoEmployerCode ?? null,
        addressLine1: companyInfo.addressLine1 ?? null,
        addressLine2: companyInfo.addressLine2 ?? null,
        postcode: companyInfo.postcode ?? null,
        city: companyInfo.city ?? null,
        state: companyInfo.state ?? null,
        country: companyInfo.country ?? "Malaysia",
        phone: companyInfo.phone ?? null,
        handphone: companyInfo.handphone ?? null,
        email: companyInfo.email ?? null,
        taxAgentName: companyInfo.taxAgentName ?? null,
        taxAgentTin: companyInfo.taxAgentTin ?? null,
        taxAgentLicenceNo: companyInfo.taxAgentLicenceNo ?? null,
        taxAgentPhone: companyInfo.taxAgentPhone ?? null,
        taxAgentEmail: companyInfo.taxAgentEmail ?? null,
        taxAgentFirmName: companyInfo.taxAgentFirmName ?? null,
        taxAgentFirmAddressLine1: companyInfo.taxAgentFirmAddressLine1 ?? null,
        taxAgentFirmAddressLine2: companyInfo.taxAgentFirmAddressLine2 ?? null,
        taxAgentFirmCity: companyInfo.taxAgentFirmCity ?? null,
        taxAgentFirmState: companyInfo.taxAgentFirmState ?? null,
        taxAgentFirmPostcode: companyInfo.taxAgentFirmPostcode ?? null,
        declarantName: companyInfo.declarantName ?? null,
        declarantIdType:
          (companyInfo.declarantIdType as PayrollCompanyInfoData["declarantIdType"]) ??
          null,
        declarantIdNumber: companyInfo.declarantIdNumber ?? null,
        declarantPosition: companyInfo.declarantPosition ?? null,
        createdAt: companyInfo.createdAt.toISOString(),
        updatedAt: companyInfo.updatedAt.toISOString(),
      }
    : null

  // Strip the LHDN E-prefix + dashes from the employer's TIN.
  const employerNo = (companyInfoData?.employerTin ?? "").replace(/[^0-9]/g, "")

  return {
    organizationId: input.organizationId,
    organizationName: org?.name ?? "",
    year: input.year,
    companyInfo: companyInfoData,
    employerNo,
    employees: Array.from(aggregates.values()).sort((a, b) =>
      a.employeeCode.localeCompare(b.employeeCode),
    ),
  }
}

function blankAggregate(
  partial: Pick<
    AnnualEmployeeAggregate,
    | "employeeProfileId"
    | "payrollProfileId"
    | "userId"
    | "employeeName"
    | "employeeCode"
    | "jobTitle"
    | "nationality"
    | "isResident"
  >,
): AnnualEmployeeAggregate {
  return {
    ...partial,
    idNumber: null,
    idType: null,
    epfNumber: null,
    socsoNumber: null,
    ssfwNumber: null,
    incomeTaxNumber: null,
    hasPr: false,
    gender: null,
    maritalStatus: null,
    spouseWorking: null,
    qualifyingChildren: 0,
    annualChildRelief: 0,
    pcbBorneByEmployer: false,
    grossSalary: 0,
    bonusAndCommission: 0,
    totalBik: 0,
    totalPcb: 0,
    totalCp38: 0,
    totalZakat: 0,
    totalEpfEmployee: 0,
    totalSocsoEmployee: 0,
    totalEisEmployee: 0,
  }
}

/**
 * CP8D tax-category code per Altomate convention:
 *   1 = Single
 *   2 = Married, spouse not working
 *   3 = Married spouse working / divorced / widowed / single with child
 */
export function cp8dTaxCategory(input: {
  maritalStatus: AnnualEmployeeAggregate["maritalStatus"]
  spouseWorking: boolean | null
  qualifyingChildren: number
}): "1" | "2" | "3" {
  if (input.maritalStatus === "MARRIED") {
    return input.spouseWorking ? "3" : "2"
  }
  if (
    input.maritalStatus === "DIVORCED" ||
    input.maritalStatus === "WIDOWED" ||
    input.maritalStatus === "SEPARATED"
  ) {
    return "3"
  }
  // Single — but if they have qualifying children, treat as cat 3.
  if (input.qualifyingChildren > 0) return "3"
  return "1"
}
