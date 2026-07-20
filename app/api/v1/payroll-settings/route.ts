import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches, bustPayrollCaches } from "@/lib/cache-invalidation"
import { payrollCompanyInfoRepository } from "@/modules/payroll/infrastructure/payroll-company-info.repository"
import type { PayrollCompanyInfoData } from "@/modules/payroll/domain/settings"

/**
 * Payroll-settings API — the org's Malaysian statutory identity
 * numbers (SSM, LHDN E, EPF, SOCSO/EIS, HRDF) plus the LHDN reference-
 * type / reference-no pair that forms the corporate tax file no.
 * (C-number). Sits alongside `/api/v1/settings` (org-wide preferences)
 * because these fields live on a different table (PayrollCompanyInfo)
 * and their write path also busts payroll caches.
 *
 * Scope: `settings:read` / `settings:write` — reuses the general
 * settings scope so an integration doesn't need a fresh grant just to
 * read/write registration numbers.
 *
 * Note on the "Tax File No. (C-number)":
 *   LHDN splits the C-number into (referenceType, referenceNo). For a
 *   Sdn Bhd, the full C-number is `C` + referenceNo when
 *   referenceType = "03" (code for Company / C). This endpoint exposes
 *   both parts as-is so the caller can compose or decompose as
 *   needed; a convenience `taxFileNumber` string is included in the
 *   GET response but is derived — writes go through the two parts.
 */

// ─── GET ─────────────────────────────────────────────────────────────

export const GET = handleApiRequest(["settings:read"], async (_request, ctx) => {
  const info = await payrollCompanyInfoRepository.getByOrgId(
    ctx.integration.organizationId,
  )
  return NextResponse.json({ data: toExternal(info) })
})

// ─── PATCH ────────────────────────────────────────────────────────────

/// Reference type codes LHDN publishes for CP8D. Kept narrow (only the
/// ones a real employer would legitimately set); if a partner needs a
/// broader code they can PATCH via the admin UI instead.
const referenceTypeCodes = ["01", "02", "03", "04", "05", "06"] as const

const nullableTrimmed = () =>
  z
    .string()
    .trim()
    .max(80)
    .nullable()
    .optional()
    .transform((v) => (v == null || v === "" ? null : v))

const updateSchema = z
  .object({
    ssmRegistrationNo: nullableTrimmed(),
    /// The LHDN Employer No. (E). Historically stored on the column
    /// literally named `employerTin`, which is misleading — kept as a
    /// friendly-named field here.
    lhdnEmployerNo: nullableTrimmed(),
    epfEmployerNo: nullableTrimmed(),
    /// PERKESO code, covers both SOCSO and EIS (single registration).
    socsoEisEmployerNo: nullableTrimmed(),
    hrdfEmployerNo: nullableTrimmed(),
    /// LHDN reference-type code (01/02/03/04/05/06 → SG/OG/C/J/D/F).
    /// Used together with `taxFileNumber` below to form the C-number
    /// for a Company (referenceType = "03", full = "C" + taxFileNumber).
    taxFileReferenceType: z
      .enum(referenceTypeCodes)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    /// Numeric part of the tax file no. (no letter prefix).
    taxFileNumber: nullableTrimmed(),
  })
  .strict()

export const PATCH = handleApiRequest(["settings:write"], async (request, ctx) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError(400, "Invalid JSON body.")
  }

  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          status: 400,
          message: "Validation failed.",
          details: parsed.error.flatten(),
        },
      },
      { status: 400 },
    )
  }

  // Map friendly field names to the underlying PayrollCompanyInfo
  // column names, only including keys the caller actually sent so
  // untouched fields stay at their existing value.
  const patch: Partial<PayrollCompanyInfoData> = {}
  if (parsed.data.ssmRegistrationNo !== undefined) {
    patch.registrationNo = parsed.data.ssmRegistrationNo
  }
  if (parsed.data.lhdnEmployerNo !== undefined) {
    patch.employerTin = parsed.data.lhdnEmployerNo
  }
  if (parsed.data.epfEmployerNo !== undefined) {
    patch.epfEmployerNo = parsed.data.epfEmployerNo
  }
  if (parsed.data.socsoEisEmployerNo !== undefined) {
    patch.perkesoEmployerCode = parsed.data.socsoEisEmployerNo
  }
  if (parsed.data.hrdfEmployerNo !== undefined) {
    patch.hrdfEmployerNo = parsed.data.hrdfEmployerNo
  }
  if (parsed.data.taxFileReferenceType !== undefined) {
    patch.referenceType = parsed.data.taxFileReferenceType
  }
  if (parsed.data.taxFileNumber !== undefined) {
    patch.referenceNo = parsed.data.taxFileNumber
  }

  if (Object.keys(patch).length === 0) {
    return jsonError(400, "Provide at least one field to update.")
  }

  try {
    await payrollCompanyInfoRepository.upsert({
      organizationId: ctx.integration.organizationId,
      patch,
    })
  } catch (error) {
    return jsonError(
      500,
      safeErrorMessage(error, "Could not save payroll company info."),
    )
  }

  // Bust both caches — the payroll-settings page reads this row via a
  // cached page-data service, and CP8D / annual-report renderers cache
  // under the payroll namespace.
  await Promise.all([
    bustOrgConfigCaches({ organizationId: ctx.integration.organizationId }),
    bustPayrollCaches({ organizationId: ctx.integration.organizationId }),
  ])

  const refreshed = await payrollCompanyInfoRepository.getByOrgId(
    ctx.integration.organizationId,
  )
  return NextResponse.json({ data: toExternal(refreshed) })
})

// ─── Helpers ──────────────────────────────────────────────────────────

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

/// LHDN reference-type code → letter prefix used in the full tax file
/// number (e.g. "03" → "C", so a Company's full TIN is "C" + referenceNo).
const REFERENCE_TYPE_PREFIX: Record<string, string> = {
  "01": "SG",
  "02": "OG",
  "03": "C",
  "04": "J",
  "05": "D",
  "06": "F",
}

/// Compose the display-friendly full tax file number from the LHDN
/// (referenceType, referenceNo) pair. Returns null if either part is
/// missing or the referenceType isn't one we recognise.
function buildTaxFileNumber(
  referenceType: string | null,
  referenceNo: string | null,
): string | null {
  if (!referenceType || !referenceNo) return null
  const prefix = REFERENCE_TYPE_PREFIX[referenceType]
  if (!prefix) return null
  return `${prefix}${referenceNo}`
}

function toExternal(info: PayrollCompanyInfoData | null) {
  if (!info) {
    return {
      ssmRegistrationNo: null,
      lhdnEmployerNo: null,
      epfEmployerNo: null,
      socsoEisEmployerNo: null,
      hrdfEmployerNo: null,
      taxFileReferenceType: null,
      taxFileNumber: null,
      taxFileFullNumber: null,
    }
  }
  return {
    ssmRegistrationNo: info.registrationNo,
    lhdnEmployerNo: info.employerTin,
    epfEmployerNo: info.epfEmployerNo,
    socsoEisEmployerNo: info.perkesoEmployerCode,
    hrdfEmployerNo: info.hrdfEmployerNo,
    taxFileReferenceType: info.referenceType,
    taxFileNumber: info.referenceNo,
    /// Convenience: full C-number-style string (e.g. "C12345678901").
    /// Derived from taxFileReferenceType + taxFileNumber. Read-only —
    /// writes go through the two parts.
    taxFileFullNumber: buildTaxFileNumber(info.referenceType, info.referenceNo),
  }
}
