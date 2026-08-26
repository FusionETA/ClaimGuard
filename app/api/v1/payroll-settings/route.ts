import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches, bustPayrollCaches } from "@/lib/cache-invalidation"
import { payrollCompanyInfoRepository } from "@/modules/payroll/infrastructure/payroll-company-info.repository"
import { payrollSettingsRepository } from "@/modules/payroll/infrastructure/payroll-settings.repository"
import {
  EMPLOYER_CATEGORY_OPTIONS,
  type PayrollCompanyInfoData,
  type PayrollSettingsData,
} from "@/modules/payroll/domain/settings"
import { calculationBlock } from "../_shared/blocks"
import {
  PAYROLL_DISBURSEMENT_BANKS,
  findBankByName,
  isPublicBankName,
  resolvePayrollFileFormat,
} from "@/modules/payroll/domain/malaysian-banks"

/**
 * Payroll-settings API — everything configured once per organisation
 * that the payroll engine and the statutory generators read:
 *
 *   - statutory identity numbers (SSM, LHDN E, EPF, SOCSO/EIS, HRDF)
 *     plus the LHDN reference-type / reference-no pair that forms the
 *     corporate tax file no. (C-number)  →  `PayrollCompanyInfo`
 *   - `profile`      — employer name, contact, correspondence address
 *                      (printed on payslips + EA/CP8D)  →  same table
 *   - `calculation`  — proration basis + HRDF levy  →  `PayrollSettings`
 *   - `bank`         — bulk-payment payor account  →  `PayrollSettings`
 *
 * Sits alongside `/api/v1/settings` (org-wide non-payroll preferences)
 * because these fields live on different tables and their write path
 * also busts payroll caches.
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
  const [info, settings] = await Promise.all([
    payrollCompanyInfoRepository.getByOrgId(ctx.integration.organizationId),
    payrollSettingsRepository.getByOrgId(ctx.integration.organizationId),
  ])
  return NextResponse.json({ data: toExternal(info, settings) })
})

// ─── PATCH ────────────────────────────────────────────────────────────

/// Reference type codes LHDN publishes for CP8D. Kept narrow (only the
/// ones a real employer would legitimately set); if a partner needs a
/// broader code they can PATCH via the admin UI instead.
/// LHDN reference-type map — the single source of truth for the
/// external API surface. Sourced from the same list the admin UI's
/// `REFERENCE_TYPE_OPTIONS` uses. The DB column stores the full
/// display value (e.g. `"03 - C"`), NOT just the two-digit code —
/// the API accepts the code for convenience and normalises to the
/// stored format on write, then reverses on read.
///
/// Kept as a flat table so adding a new LHDN code = one row edit
/// and the API + display + prefix all stay in sync.
const REFERENCE_TYPES = [
  { code: "01", prefix: "SG", storedValue: "01 - SG" },
  { code: "02", prefix: "OG", storedValue: "02 - OG" },
  { code: "03", prefix: "C", storedValue: "03 - C" },
  { code: "04", prefix: "D", storedValue: "04 - D" },
  { code: "05", prefix: "F", storedValue: "05 - F" },
  { code: "06", prefix: "TR", storedValue: "06 - TR" },
  { code: "07", prefix: "LE", storedValue: "07 - LE" },
] as const
const referenceTypeCodes = REFERENCE_TYPES.map((r) => r.code) as [
  string,
  ...string[],
]
const CODE_TO_STORED = new Map<string, string>(
  REFERENCE_TYPES.map((r) => [r.code, r.storedValue]),
)
const STORED_TO_CODE = new Map<string, string>(
  REFERENCE_TYPES.map((r) => [r.storedValue, r.code]),
)
const CODE_TO_PREFIX = new Map<string, string>(
  REFERENCE_TYPES.map((r) => [r.code, r.prefix]),
)

/// LHDN employer-category values, exactly as `EMPLOYER_CATEGORY_OPTIONS`
/// stores them (the column holds the full display string, same pattern as
/// `referenceType` above). Derived from the shared domain list so the API
/// and the admin dropdown can't drift apart.
const employerCategoryValues = EMPLOYER_CATEGORY_OPTIONS.map(
  (o) => o.value,
) as [string, ...string[]]

/// Partner-facing legal form → LHDN employer category. Lossy on purpose
/// (6 → 2): LHDN only distinguishes "company" from "other private
/// sector". See the `companyType` field docs.
///
/// The right-hand values MUST match `EMPLOYER_CATEGORY_OPTIONS` verbatim
/// — the column stores the full display string, so a typo here writes a
/// value the admin dropdown can't render and silently shows blank.
/// Verified against the domain list; re-check if either side changes.
const COMPANY_TYPE_TO_EMPLOYER_CATEGORY: Record<string, string> = {
  SDN_BHD: "6 - Company",
  BHD: "6 - Company",
  ENTERPRISE: "5 - Private Sector (Other than Company)",
  PARTNERSHIP: "5 - Private Sector (Other than Company)",
  LLP: "5 - Private Sector (Other than Company)",
  SOLE_PROPRIETOR: "5 - Private Sector (Other than Company)",
}

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
    /// Employer zakat registration number for the *potongan zakat
    /// berjadual* scheme (LZS, PPZ-MAIWP, MAIDAM, …). Feeds the company
    /// profile + payslip footer.
    ///
    /// ONE value per organisation. Zakat is state-administered, so a
    /// multi-state employer holding several registrations can only
    /// record one of them here — keep the full set on your side.
    ///
    /// Distinct from EMPLOYEE zakat, which is already handled per
    /// employee (`deduct_zakat` line item + `prevZakat` YTD carry-in)
    /// and is not set through this endpoint.
    zakatNumber: nullableTrimmed(),
    /// LHDN reference-type code:
    ///   01 → SG (Individual non-business)
    ///   02 → OG (Individual business)
    ///   03 → C  (Company)
    ///   04 → D  (Partnership)
    ///   05 → F  (Co-operative society)
    ///   06 → TR (Trust body)
    ///   07 → LE (Limited liability partnership)
    /// Used together with `taxFileNumber` below to form the full
    /// tax file no. (e.g. code "03" + no. "12345678901" = "C12345678901").
    /// The DB column stores the full display value (e.g. "03 - C") —
    /// this endpoint normalises the two-digit code you send to that
    /// format on write, then reverses on read. Pass just "03" here.
    taxFileReferenceType: z
      .enum(referenceTypeCodes)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    /// Numeric part of the tax file no. (no letter prefix).
    taxFileNumber: nullableTrimmed(),

    // ── profile ──────────────────────────────────────────────────────
    /// Employer identity + correspondence details. These are NOT
    /// cosmetic: `employerName` heads every statutory document, and the
    /// address block is printed on payslips and the EA / CP8D forms, so
    /// they're gated by the pre-submit readiness check.
    ///
    /// `employerName` is the payroll filing name, which is deliberately
    /// separate from the AltomateHR workspace name (`name` on
    /// `PATCH /api/v1/settings`) — an org can trade under one label and
    /// file under its registered one. Set both if they should match.
    ///
    /// `otherLocations` is not modelled here — there's no org-level
    /// concept for it. Model each branch as a project
    /// (`POST /api/v1/projects`), which also gets it a working calendar
    /// and geofence that a bare address wouldn't have.
    profile: z
      .object({
        employerName: nullableTrimmed(),
        /// Legal form of the entity, in the partner's vocabulary.
        /// Stored as LHDN's `employerCategory` (Form E "Kategori
        /// Majikan"), which is the field this maps onto.
        ///
        /// ⚠ THE MAPPING IS LOSSY — 6 values collapse to 2:
        ///     SDN_BHD, BHD                              → "6 - Company"
        ///     ENTERPRISE, PARTNERSHIP, LLP,
        ///     SOLE_PROPRIETOR                           → "5 - Private
        ///                                                  Sector (Other
        ///                                                  than Company)"
        /// So a GET cannot tell you back which of the four "5" forms the
        /// client actually is. Whoever collects this must keep the
        /// original value on their side — reading it back from here is
        /// not a substitute for their own record.
        ///
        /// LLP → 5 is our reading (an LLP is a body corporate but not a
        /// "company" under the Companies Act; LHDN issues it reference
        /// type 07 - LE). Worth confirming with your payroll department
        /// before relying on it for Form E.
        companyType: z
          .enum([
            "SDN_BHD",
            "BHD",
            "ENTERPRISE",
            "PARTNERSHIP",
            "LLP",
            "SOLE_PROPRIETOR",
          ])
          .optional(),
        /// The same setting in LHDN's own vocabulary, written verbatim.
        /// Use this instead of `companyType` when you hold the LHDN
        /// category directly and don't want the lossy mapping applied.
        /// Sending both is a 400 — they write one column.
        employerCategory: z
          .enum(employerCategoryValues)
          .nullable()
          .optional()
          .transform((v) => (v == null || v === "" ? null : v)),
        email: z
          .string()
          .trim()
          .email("Enter a valid employer email.")
          .max(120)
          .nullable()
          .optional()
          .transform((v) => (v == null || v === "" ? null : v)),
        /// Landline / main contact number.
        phone: nullableTrimmed(),
        /// Mobile. LHDN's Form E asks for both separately.
        handphone: nullableTrimmed(),
        address: z
          .object({
            line1: nullableTrimmed(),
            line2: nullableTrimmed(),
            city: nullableTrimmed(),
            /// Free-text state name as printed on statutory forms —
            /// NOT one of the 16 two/three-letter state codes. We don't
            /// hold a coded state anywhere.
            state: nullableTrimmed(),
            postcode: nullableTrimmed(),
            country: nullableTrimmed(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),

    // ── calculation ──────────────────────────────────────────────────
    /// The two calculation rules that ARE configurable per org. Shared
    /// verbatim with `PUT /api/v1/onboarding`, so the block itself —
    /// including the list of rules that are fixed engine behaviour
    /// rather than settings — lives in
    /// `app/api/v1/_shared/blocks.ts`. Don't re-declare it here.
    calculation: calculationBlock.optional(),

    // ── bank ─────────────────────────────────────────────────────────
    /// The company's PAYOR bank details — the account salaries are paid
    /// FROM, and the debiting account on the bulk-payment file.
    ///
    /// NOT a general-purpose "company bank account" block: `bankName` /
    /// `bankAccountNumber` / `bankAccountHolderName` in AltomateHR
    /// belong to the EMPLOYEE (`PayrollProfile`) and are set per
    /// employee via `/api/v1/employees`. Everything here is the
    /// employer side.
    ///
    /// `bankName` decides which file the run download emits:
    ///   Public Bank → PB ECP XLSX  ·  any other bank → general CSV.
    /// Read `supportedFormats` / `activeFormat` on the GET rather than
    /// assuming either.
    bank: z
      .object({
        /// Payor bank, matched against the `MALAYSIAN_BANKS` catalogue
        /// — aliases like `"maybank"` or `"cimb"` resolve,
        /// and the canonical name is what gets stored. An unmatched
        /// name is a 400 rather than a silent free-text write, because
        /// the stored value selects the output format. `GET` returns
        /// the full catalogue under `bank.availableBanks` for a picker.
        /// Null clears it (and the org falls back to the general CSV).
        bankName: z
          .string()
          .trim()
          .max(120)
          .nullable()
          .optional()
          .transform((v) => (v == null || v === "" ? null : v)),
        /// Debiting account. Non-digits are stripped, so
        /// `"1234-567890"` is fine.
        ///
        /// Length is validated against the resolved bank, NOT globally:
        /// the Public Bank ECP spec requires exactly 10 digits, but
        /// every other bank's account is its own length, so a hard
        /// 10-digit rule would reject valid Maybank/CIMB accounts. The
        /// check runs in the handler where the effective bank is known
        /// (this request's `bankName`, else the stored one).
        payorAccountNo: z
          .string()
          .trim()
          .max(40)
          .nullable()
          .optional()
          .transform((v) => {
            if (v == null || v === "") return null
            return v.replace(/[^0-9]/g, "")
          }),
        /// SWIFT/BIC of the payor's bank. Optional — when you send
        /// `bankName` and omit this, we fill it from the catalogue, so
        /// there's no need to put a BIC field on a setup form. Send it
        /// explicitly only to override the catalogue value.
        payorBic: z
          .string()
          .trim()
          .regex(
            /^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/,
            "payorBic must be an 8- or 11-character SWIFT/BIC code.",
          )
          .nullable()
          .optional()
          .transform((v) => (v == null || v === "" ? null : v.toUpperCase())),
        /// Name on the payor account, as the bank has it. Printed in
        /// the general CSV header.
        accountHolderName: z
          .string()
          .trim()
          .max(120)
          .nullable()
          .optional()
          .transform((v) => (v == null || v === "" ? null : v)),
        /// The corporate identifier a bank requires on a bulk-salary
        /// file — CIMB calls it Organisation Code, Maybank2E and RHB
        /// Corporate ID. One value per company. Written to the general
        /// CSV header; the PB ECP file has no field for it.
        organisationCode: z
          .string()
          .trim()
          .max(60)
          .nullable()
          .optional()
          .transform((v) => (v == null || v === "" ? null : v)),
      })
      .strict()
      .optional(),
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
  if (parsed.data.zakatNumber !== undefined) {
    patch.zakatNumber = parsed.data.zakatNumber
  }
  if (parsed.data.taxFileReferenceType !== undefined) {
    // Caller sends the two-digit code (e.g. "03"); DB stores the
    // full display value the admin-UI dropdown writes (e.g. "03 - C").
    // Null clears the column.
    patch.referenceType =
      parsed.data.taxFileReferenceType === null
        ? null
        : (CODE_TO_STORED.get(parsed.data.taxFileReferenceType) ?? null)
  }
  if (parsed.data.taxFileNumber !== undefined) {
    patch.referenceNo = parsed.data.taxFileNumber
  }

  // The `profile` block lands on the same PayrollCompanyInfo row as the
  // registration numbers above, so it merges into the same patch.
  const profile = parsed.data.profile
  if (profile) {
    if (
      profile.companyType !== undefined &&
      profile.employerCategory !== undefined
    ) {
      return jsonError(
        400,
        "Send either `profile.companyType` or `profile.employerCategory`, not both — they write the same column.",
      )
    }
    if (profile.companyType !== undefined) {
      patch.employerCategory =
        COMPANY_TYPE_TO_EMPLOYER_CATEGORY[profile.companyType] ?? null
    } else if (profile.employerCategory !== undefined) {
      patch.employerCategory = profile.employerCategory
    }
    if (profile.employerName !== undefined) {
      patch.employerName = profile.employerName
    }
    if (profile.email !== undefined) patch.email = profile.email
    if (profile.phone !== undefined) patch.phone = profile.phone
    if (profile.handphone !== undefined) patch.handphone = profile.handphone
    if (profile.address) {
      const a = profile.address
      if (a.line1 !== undefined) patch.addressLine1 = a.line1
      if (a.line2 !== undefined) patch.addressLine2 = a.line2
      if (a.city !== undefined) patch.city = a.city
      if (a.state !== undefined) patch.state = a.state
      if (a.postcode !== undefined) patch.postcode = a.postcode
      // `country` is non-nullable on the domain type (defaults to
      // "Malaysia"), so clearing it isn't meaningful — only a real
      // value is written through.
      if (a.country != null) patch.country = a.country
    }
  }

  // `calculation` + `bank` live on PayrollSettings, a different table
  // with its own repo.
  const settingsPatch: Partial<
    Omit<PayrollSettingsData, "id" | "organizationId" | "createdAt" | "updatedAt">
  > = {}
  if (parsed.data.calculation?.prorationBasis !== undefined) {
    settingsPatch.workingDaysRule = parsed.data.calculation.prorationBasis
  }
  if (parsed.data.calculation?.hrdf !== undefined) {
    const hrdf = parsed.data.calculation.hrdf
    settingsPatch.hrdfEnabled = hrdf.contribute
    // Turning HRDF off clears the rate so a later re-enable can't
    // silently inherit a stale percentage.
    settingsPatch.hrdfRate = hrdf.contribute ? (hrdf.rate ?? null) : null
  }
  const bank = parsed.data.bank
  if (bank) {
    // Resolve the bank this request leaves the org on: the one being
    // set now, else whatever is already stored. Needed before the
    // account-number check, because the length rule is bank-specific.
    let effectiveBankName: string | null
    if (bank.bankName !== undefined) {
      if (bank.bankName === null) {
        effectiveBankName = null
      } else {
        const matched = findBankByName(bank.bankName)
        if (!matched) {
          return jsonError(
            400,
            `Unrecognised bank name "${bank.bankName}". It must match a Malaysian bank in our catalogue — read \`bank.availableBanks\` from GET /api/v1/payroll-settings for the accepted list.`,
          )
        }
        // Only banks with a native bulk-payroll format can be the
        // disbursement bank — otherwise the run would have no bank file
        // to download at all.
        if (matched.payrollFormat == null) {
          return jsonError(
            400,
            `"${matched.name}" is not supported as a payroll disbursement bank. Supported banks: ${PAYROLL_DISBURSEMENT_BANKS.map((b) => b.name).join(", ")}.`,
          )
        }
        // Store the CANONICAL name. The stored value is what
        // `resolvePayrollFileFormat` reads to choose the output format,
        // so a free-text variant must never reach the column.
        effectiveBankName = matched.name
      }
      settingsPatch.payrollBankName = effectiveBankName
    } else {
      const existing = await payrollSettingsRepository.getByOrgId(
        ctx.integration.organizationId,
      )
      effectiveBankName = existing?.payrollBankName ?? null
    }

    if (bank.payorAccountNo !== undefined) {
      // Public Bank ECP mandates exactly 10 digits. Other banks each
      // have their own length, so we only assert a sane range there
      // rather than inventing a rule per bank.
      const acc = bank.payorAccountNo
      if (acc !== null) {
        if (isPublicBankName(effectiveBankName)) {
          if (acc.length !== 10) {
            return jsonError(
              400,
              `payorAccountNo must be exactly 10 digits for Public Bank (ECP spec); got ${acc.length}.`,
            )
          }
        } else if (acc.length < 5 || acc.length > 20) {
          return jsonError(
            400,
            `payorAccountNo must be between 5 and 20 digits; got ${acc.length}.`,
          )
        }
      }
      settingsPatch.ecpPayorAccountNo = acc
    }

    if (bank.payorBic !== undefined) {
      settingsPatch.ecpPayorBic = bank.payorBic
    } else if (bank.bankName !== undefined) {
      // Caller changed the bank but sent no BIC. Derive it from the
      // catalogue so a setup form never has to ask for a SWIFT code —
      // and, when the bank is cleared, clear the BIC with it rather
      // than leaving one pointing at a bank no longer configured.
      const matched = effectiveBankName
        ? findBankByName(effectiveBankName)
        : null
      settingsPatch.ecpPayorBic = matched?.bic ?? null
    }

    if (bank.accountHolderName !== undefined) {
      settingsPatch.payorAccountHolderName = bank.accountHolderName
    }
    if (bank.organisationCode !== undefined) {
      settingsPatch.payorOrganisationCode = bank.organisationCode
    }
  }

  if (Object.keys(patch).length === 0 && Object.keys(settingsPatch).length === 0) {
    return jsonError(400, "Provide at least one field to update.")
  }

  try {
    if (Object.keys(patch).length > 0) {
      await payrollCompanyInfoRepository.upsert({
        organizationId: ctx.integration.organizationId,
        patch,
      })
    }
    if (Object.keys(settingsPatch).length > 0) {
      await payrollSettingsRepository.upsert({
        organizationId: ctx.integration.organizationId,
        patch: settingsPatch,
      })
    }
  } catch (error) {
    return jsonError(
      500,
      safeErrorMessage(error, "Could not save payroll settings."),
    )
  }

  // Bust both caches — the payroll-settings page reads this row via a
  // cached page-data service, and CP8D / annual-report renderers cache
  // under the payroll namespace.
  await Promise.all([
    bustOrgConfigCaches({ organizationId: ctx.integration.organizationId }),
    bustPayrollCaches({ organizationId: ctx.integration.organizationId }),
  ])

  const [refreshed, refreshedSettings] = await Promise.all([
    payrollCompanyInfoRepository.getByOrgId(ctx.integration.organizationId),
    payrollSettingsRepository.getByOrgId(ctx.integration.organizationId),
  ])
  return NextResponse.json({
    data: toExternal(refreshed, refreshedSettings),
  })
})

// ─── Helpers ──────────────────────────────────────────────────────────

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: { status, message } }, { status })
}

/// Read the two-digit code from a DB row's `referenceType` string.
/// The column stores the full display value ("03 - C"), so we look
/// it up in the reverse map. Returns null for unknown / empty values.
function extractReferenceCode(dbReferenceType: string | null): string | null {
  if (!dbReferenceType) return null
  return STORED_TO_CODE.get(dbReferenceType) ?? null
}

/// Compose the display-friendly full tax file number from the DB row's
/// `referenceType` ("03 - C") + `referenceNo` ("12345678901") →
/// "C12345678901". Returns null if either part is missing or the
/// referenceType isn't one we recognise.
function buildTaxFileNumber(
  dbReferenceType: string | null,
  referenceNo: string | null,
): string | null {
  const code = extractReferenceCode(dbReferenceType)
  if (!code || !referenceNo) return null
  const prefix = CODE_TO_PREFIX.get(code)
  if (!prefix) return null
  return `${prefix}${referenceNo}`
}

/// Project the PayrollSettings half of the response. Both blocks are
/// reported even when no row exists yet, using the same defaults the
/// Prisma schema bakes in — so a partner reading before the first save
/// sees the rules that WOULD apply rather than a misleading null.
function toExternalSettings(settings: PayrollSettingsData | null) {
  return {
    calculation: {
      /// `PayrollSettings.workingDaysRule`. Schema default is
      /// TWENTY_SIX.
      prorationBasis: settings?.workingDaysRule ?? "TWENTY_SIX",
      hrdf: {
        contribute: settings?.hrdfEnabled ?? false,
        rate: settings?.hrdfRate ?? null,
      },
      /// Read-only: rules our engine fixes rather than exposes. Sent so
      /// a partner UI can render them as stated behaviour instead of
      /// offering a choice we can't honour. See the `calculation` block
      /// in the PATCH schema for why each is fixed.
      fixed: {
        unpaidLeaveBasis: "SAME_AS_PRORATION_BASIS",
        recordUnpaidLeaveInPayroll: true,
        adjustSalaryByJoinDate: true,
      },
    },
    bank: {
      bankName: settings?.payrollBankName ?? null,
      payorAccountNo: settings?.ecpPayorAccountNo ?? null,
      /// Null means the PB ECP renderer falls back to PBBEMYKL.
      payorBic: settings?.ecpPayorBic ?? null,
      accountHolderName: settings?.payorAccountHolderName ?? null,
      organisationCode: settings?.payorOrganisationCode ?? null,
      /// Bulk-payment formats this deployment can emit at all.
      ///
      /// `PUBLIC_BANK_ECP_XLSX` is Public Bank's native ECP upload.
      /// `GENERAL_CSV` is a bank-agnostic salary CSV (payee, bank, BIC,
      /// account no, amount) for every other bank — it is NOT CIMB's,
      /// Maybank2E's or RHB's own bulk-upload format, so a client on
      /// those banks imports the CSV rather than getting a native file.
      supportedFormats: [
        "PB_ECP_XLSX",
        "MBB_M2E_TXT",
        "CIMB_BIZCHANNEL_TXT",
      ],
      /// Which of the above THIS org's run download will actually
      /// produce, derived from `bankName`. Exactly one is offered per
      /// run, so read this rather than inferring from the list.
      /// Null when no disbursement bank is configured (or the stored
      /// value predates the supported list) — the run then offers no
      /// bank file until one is set.
      activeFormat: resolvePayrollFileFormat(settings?.payrollBankName),
      /// The accepted `bankName` values, for a picker. Sending a name
      /// outside this catalogue is a 400 — aliases resolve, but the
      /// canonical `name` is what gets stored.
      /// Banks accepted as the payroll disbursement bank — only those
      /// we can generate a native bulk-payroll file for. This does NOT
      /// limit where employees bank; every format pays out to any
      /// Malaysian bank.
      availableBanks: PAYROLL_DISBURSEMENT_BANKS.map((b) => ({
        name: b.name,
        bic: b.bic,
        format: b.payrollFormat,
      })),
    },
  }
}

function toExternal(
  info: PayrollCompanyInfoData | null,
  settings: PayrollSettingsData | null,
) {
  if (!info) {
    return {
      ssmRegistrationNo: null,
      lhdnEmployerNo: null,
      epfEmployerNo: null,
      socsoEisEmployerNo: null,
      hrdfEmployerNo: null,
      zakatNumber: null,
      taxFileReferenceType: null,
      taxFileNumber: null,
      taxFileFullNumber: null,
      profile: {
        employerName: null,
        email: null,
        phone: null,
        handphone: null,
        address: {
          line1: null,
          line2: null,
          city: null,
          state: null,
          postcode: null,
          country: null,
        },
        employerCategory: null,
      },
      ...toExternalSettings(settings),
    }
  }
  return {
    ssmRegistrationNo: info.registrationNo,
    lhdnEmployerNo: info.employerTin,
    epfEmployerNo: info.epfEmployerNo,
    socsoEisEmployerNo: info.perkesoEmployerCode,
    hrdfEmployerNo: info.hrdfEmployerNo,
    /// One value per org — see the PATCH field docs on multi-state
    /// employers.
    zakatNumber: info.zakatNumber,
    /// Two-digit LHDN code (`"03"` etc). DB actually stores the full
    /// display value (`"03 - C"`) — we parse it back to the code
    /// here so the external contract matches what PATCH accepts.
    /// Returns null when the DB has a stored value we don't
    /// recognise (unlikely; belt-and-braces).
    taxFileReferenceType: extractReferenceCode(info.referenceType),
    taxFileNumber: info.referenceNo,
    /// Convenience: full C-number-style string (e.g. "C12345678901").
    /// Derived from taxFileReferenceType + taxFileNumber. Read-only —
    /// writes go through the two parts.
    taxFileFullNumber: buildTaxFileNumber(info.referenceType, info.referenceNo),
    profile: {
      employerName: info.employerName,
      email: info.email,
      phone: info.phone,
      handphone: info.handphone,
      address: {
        line1: info.addressLine1,
        line2: info.addressLine2,
        city: info.city,
        state: info.state,
        postcode: info.postcode,
        country: info.country,
      },
      /// LHDN's employer category, stored as a display string
      /// ("6 - Company"). This is the column `companyType` writes to.
      /// Note there is NO `companyType` in the response: the mapping
      /// collapses 6 legal forms into 2 categories, so we can't
      /// reconstruct which one was sent. Keep the original on your side.
      employerCategory: info.employerCategory,
    },
    ...toExternalSettings(settings),
  }
}
