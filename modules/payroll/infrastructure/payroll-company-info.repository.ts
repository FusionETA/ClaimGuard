import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import type { PayrollCompanyInfoData } from "@/modules/payroll/domain/settings"

/**
 * Per-org `PayrollCompanyInfo` (employer Form E filing identity).
 * 1:1 with Organization — upsert by organizationId. All fields are
 * optional strings; admin fills them in as needed for filing.
 */
export const payrollCompanyInfoRepository = {
  async getByOrgId(
    organizationId: string,
  ): Promise<PayrollCompanyInfoData | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.payrollCompanyInfo.findUnique({
      where: { organizationId },
    })
    if (!row) return null
    return mapPayrollCompanyInfo(row)
  },

  async upsert(input: {
    organizationId: string
    patch: Partial<Omit<PayrollCompanyInfoData, "id" | "organizationId" | "createdAt" | "updatedAt">>
  }): Promise<PayrollCompanyInfoData> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const data = toUpsertData(input.patch)

    const row = await prisma.payrollCompanyInfo.upsert({
      where: { organizationId: input.organizationId },
      create: { organizationId: input.organizationId, ...data },
      update: data,
    })

    return mapPayrollCompanyInfo(row)
  },
}

function mapPayrollCompanyInfo(row: any): PayrollCompanyInfoData {
  return {
    id: row.id,
    organizationId: row.organizationId,
    employerName: row.employerName ?? null,
    employerTin: row.employerTin ?? null,
    registrationNo: row.registrationNo ?? null,
    referenceType: row.referenceType ?? null,
    referenceNo: row.referenceNo ?? null,
    employerCategory: row.employerCategory ?? null,
    employerStatus: row.employerStatus ?? null,
    cp8dFurnishType: row.cp8dFurnishType ?? null,
    perkesoEmployerCode: row.perkesoEmployerCode ?? null,
    addressLine1: row.addressLine1 ?? null,
    addressLine2: row.addressLine2 ?? null,
    postcode: row.postcode ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    country: row.country ?? "Malaysia",
    phone: row.phone ?? null,
    handphone: row.handphone ?? null,
    email: row.email ?? null,
    taxAgentName: row.taxAgentName ?? null,
    taxAgentTin: row.taxAgentTin ?? null,
    taxAgentLicenceNo: row.taxAgentLicenceNo ?? null,
    taxAgentPhone: row.taxAgentPhone ?? null,
    taxAgentEmail: row.taxAgentEmail ?? null,
    taxAgentFirmName: row.taxAgentFirmName ?? null,
    taxAgentFirmAddressLine1: row.taxAgentFirmAddressLine1 ?? null,
    taxAgentFirmAddressLine2: row.taxAgentFirmAddressLine2 ?? null,
    taxAgentFirmPostcode: row.taxAgentFirmPostcode ?? null,
    taxAgentFirmCity: row.taxAgentFirmCity ?? null,
    taxAgentFirmState: row.taxAgentFirmState ?? null,
    declarantName: row.declarantName ?? null,
    declarantIdType: row.declarantIdType ?? null,
    declarantIdNumber: row.declarantIdNumber ?? null,
    declarantPosition: row.declarantPosition ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toUpsertData(
  patch: Partial<Omit<PayrollCompanyInfoData, "id" | "organizationId" | "createdAt" | "updatedAt">>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const copy = <K extends keyof typeof patch>(k: K) => {
    if (patch[k] !== undefined) out[k as string] = patch[k]
  }
  copy("employerName")
  copy("employerTin")
  copy("registrationNo")
  copy("referenceType")
  copy("referenceNo")
  copy("employerCategory")
  copy("employerStatus")
  copy("cp8dFurnishType")
  copy("perkesoEmployerCode")
  copy("addressLine1")
  copy("addressLine2")
  copy("postcode")
  copy("city")
  copy("state")
  copy("country")
  copy("phone")
  copy("handphone")
  copy("email")
  copy("taxAgentName")
  copy("taxAgentTin")
  copy("taxAgentLicenceNo")
  copy("taxAgentPhone")
  copy("taxAgentEmail")
  copy("taxAgentFirmName")
  copy("taxAgentFirmAddressLine1")
  copy("taxAgentFirmAddressLine2")
  copy("taxAgentFirmPostcode")
  copy("taxAgentFirmCity")
  copy("taxAgentFirmState")
  copy("declarantName")
  copy("declarantIdType")
  copy("declarantIdNumber")
  copy("declarantPosition")
  return out
}
