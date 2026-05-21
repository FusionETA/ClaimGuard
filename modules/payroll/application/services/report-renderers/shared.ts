import "server-only"

import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import { toNumber } from "@/lib/decimal"
import type {
  PayrollCompanyInfoData,
} from "@/modules/payroll/domain/settings"
import type { PayslipRow } from "@/modules/payroll/domain/runs"
import { payrollCompanyInfoRepository } from "@/modules/payroll/infrastructure/payroll-company-info.repository"
import { payslipRepository } from "@/modules/payroll/infrastructure/payslip.repository"

/**
 * Per-employee identity fields needed by the statutory file
 * generators (EPF CSV, SOCSO+EIS TXT, PCB TXT) and the calc-detail
 * sections of the Payment Schedule + Detailed Calculations PDFs.
 *
 * These come from the live PayrollProfile (NOT snapshotted onto the
 * payslip yet) so any mid-month edits to e.g. an employee's EPF
 * number show up the next time files are regenerated. A future
 * iteration may move these to payslip snapshots for tighter audit.
 */
export type StatutoryEmployeeRow = {
  /// Joined payslip with all the calculated amounts.
  payslip: PayslipRow
  /// Friendly employee identity for human-readable rows.
  employeeName: string
  employeeCode: string
  jobTitle: string | null

  /// Statutory numbers — every one can be null/empty when the admin
  /// hasn't filled it in yet. Generators are expected to handle that
  /// gracefully (e.g. PCB skips zero-PCB employees, EPF CSV omits the
  /// row when no EPF# is on file).
  idNumber: string | null
  idType: "IC" | "PASSPORT" | "OTHER" | null
  epfNumber: string | null
  socsoNumber: string | null
  ssfwNumber: string | null
  incomeTaxNumber: string | null

  /// Demographics needed for wife code (PCB) + foreign-worker routing
  /// (SOCSO). Nationality is a free-text country string ("Malaysian",
  /// "Singaporean", ...). `hasPr` is a separate flag because PRs are
  /// non-Malaysian but treated differently by EPF.
  nationality: string | null
  hasPr: boolean
  gender: "MALE" | "FEMALE" | "OTHER" | null
  maritalStatus:
    | "SINGLE"
    | "MARRIED"
    | "DIVORCED"
    | "WIDOWED"
    | "SEPARATED"
    | null
}

export type StatutoryRunPayload = {
  run: {
    id: string
    periodYear: number
    periodMonth: number
  }
  organizationName: string
  companyInfo: PayrollCompanyInfoData | null
  /// One row per payslip on the run, joined with the live employee
  /// identity. Ordered by employee code so the output is stable
  /// across regenerations.
  rows: StatutoryEmployeeRow[]
}

/**
 * One-shot loader for every report renderer. Pulls the run's
 * organization, company info, payslips + live PayrollProfile identity
 * fields, and projects them into a stable shape generators can iterate.
 */
export async function loadStatutoryRunPayload(input: {
  runId: string
  organizationId: string
}): Promise<StatutoryRunPayload | null> {
  const prisma = getPrismaClient()
  if (!prisma) return null

  const [run, org, companyInfo, payslips] = await Promise.all([
    prisma.payrollRun.findFirst({
      where: { id: input.runId, organizationId: input.organizationId },
      select: { id: true, periodYear: true, periodMonth: true },
    }),
    prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { name: true },
    }),
    payrollCompanyInfoRepository.getByOrgId(input.organizationId),
    payslipRepository.listForRun(input.runId),
  ])

  if (!run) return null

  // Fetch live PayrollProfile rows for every payroll-profile-id that
  // appears on a payslip. The IN-list is bounded by the org's
  // headcount, so this is one query.
  const profileIds = Array.from(
    new Set(
      payslips
        .map((p) => p.payrollProfileId)
        .filter((id): id is string => id != null),
    ),
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
            gender: true,
            maritalStatus: true,
            employeeProfile: {
              select: {
                employeeId: true,
                jobTitle: true,
                user: { select: { name: true } },
              },
            },
          },
        })

  const profileById = new Map(profiles.map((p) => [p.id, p]))

  const rows: StatutoryEmployeeRow[] = payslips
    .map((payslip) => {
      const profile = payslip.payrollProfileId
        ? profileById.get(payslip.payrollProfileId)
        : undefined

      const ep = profile?.employeeProfile
      return {
        payslip,
        employeeName: ep?.user.name ?? payslip.snapshotName,
        employeeCode: ep?.employeeId ?? payslip.snapshotEmployeeId,
        jobTitle: ep?.jobTitle ?? payslip.snapshotPosition,
        idNumber: profile?.idNumber ?? null,
        idType: (profile?.idType as StatutoryEmployeeRow["idType"]) ?? null,
        epfNumber: profile?.epfNumber ?? null,
        socsoNumber: profile?.socsoNumber ?? null,
        ssfwNumber: profile?.ssfwNumber ?? null,
        incomeTaxNumber: profile?.incomeTaxNumber ?? null,
        nationality: profile?.nationality ?? payslip.snapshotNationality,
        hasPr: profile?.hasPr ?? false,
        gender:
          (profile?.gender as StatutoryEmployeeRow["gender"]) ?? null,
        maritalStatus:
          (profile?.maritalStatus as StatutoryEmployeeRow["maritalStatus"]) ??
          null,
      }
    })
    .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))

  return {
    run,
    organizationName: org?.name ?? "",
    companyInfo,
    rows,
  }
}

/// Right-pad a string to `width` with spaces, truncate if too long.
export function padRight(s: string | null | undefined, width: number): string {
  const value = (s ?? "").toString()
  if (value.length >= width) return value.slice(0, width)
  return value + " ".repeat(width - value.length)
}

/// Left-pad a string to `width` with spaces, truncate from the left if
/// too long (preserves the right-aligned digits in numeric fields).
export function padLeft(s: string | null | undefined, width: number): string {
  const value = (s ?? "").toString()
  if (value.length >= width) return value.slice(value.length - width)
  return " ".repeat(width - value.length) + value
}

/// Left-pad a numeric string to `width` with zeros.
export function padZero(n: number | string, width: number): string {
  const s = typeof n === "number" ? Math.round(n).toString() : n
  if (s.length >= width) return s.slice(s.length - width)
  return "0".repeat(width - s.length) + s
}

/// Convert RM amount to sen (rounded to nearest sen, no decimal).
export function toSen(rm: number | null | undefined): number {
  if (rm == null) return 0
  return Math.round(rm * 100)
}

/// Strip dashes + spaces from an IC number, keep digits only.
export function normaliseNewIc(idNumber: string | null | undefined): string {
  if (!idNumber) return ""
  return idNumber.replace(/[^0-9]/g, "")
}

/// Strip the SG/OG prefix and dashes from a LHDN tax reference. Returns
/// the raw 10-digit number ready for zero-padding.
export function normaliseTaxRef(taxRef: string | null | undefined): string {
  if (!taxRef) return ""
  // Strip "SG", "OG", "C", spaces, and dashes — keeps digits.
  return taxRef.replace(/[A-Za-z\s\-_()]/g, "")
}

/// Last digit of the LHDN tax reference, used as the PCB "wife code"
/// (0 = male / single female, 1–9 = married female sharing tax with
/// husband). Falls back to 0 when the tax ref isn't available.
export function pcbWifeCode(input: {
  taxRef: string | null | undefined
  gender: StatutoryEmployeeRow["gender"]
  maritalStatus: StatutoryEmployeeRow["maritalStatus"]
}): string {
  const ref = normaliseTaxRef(input.taxRef)
  if (ref.length === 0) return "0"
  // For tax refs >= 11 digits the last digit IS the wife code.
  if (ref.length >= 11) return ref.slice(-1)
  // Otherwise infer from gender/marital status.
  if (input.gender === "FEMALE" && input.maritalStatus === "MARRIED") return "1"
  return "0"
}

/// Strip the wife code off the tax ref so we can pad it independently.
/// Returns the leading 10 digits (or fewer if the source is shorter).
export function taxRefWithoutWifeCode(
  taxRef: string | null | undefined,
): string {
  const ref = normaliseTaxRef(taxRef)
  if (ref.length === 0) return ""
  if (ref.length >= 11) return ref.slice(0, -1)
  return ref
}

/// Format `rm` as `RMxx,xxx.xx`. Used in PDF cells.
export function formatRm(rm: number | null | undefined): string {
  const v = rm ?? 0
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v)
}

/// Decimal-aware sum helper used by a few renderers.
export function sumDecimal<T>(arr: ReadonlyArray<T>, fn: (t: T) => number | null | undefined): number {
  return arr.reduce<number>((acc, x) => acc + (toNumber(fn(x), 0) ?? 0), 0)
}
