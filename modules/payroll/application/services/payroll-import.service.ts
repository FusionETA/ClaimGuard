import "server-only"
import { isAdminRole } from "@/lib/auth/types"

import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { hashPassword } from "@/lib/auth/password"
import { assertEmailAvailableForNewUser } from "@/lib/auth/email-uniqueness"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { safeErrorMessage } from "@/lib/errors"
import type { Prisma } from "@/generated/prisma/client"
import { getPayrollPrismaClientSafe as getPrismaClient } from "@/modules/payroll/infrastructure/payroll-run.repository"
import {
  genders,
  idTypes,
  importableEmployeeTypes,
  maritalStatuses,
  paymentMethods,
  salaryTypes,
  socsoSchemes,
} from "@/modules/payroll/domain/models"
import { recommendSocsoScheme } from "@/modules/payroll/domain/statutory-tables"
import { isMalaysianNationality } from "@/modules/payroll/domain/calc"
import {
  countActiveLeaveTypesForOrg,
  type LeaveSeedInput,
  seedEmployeeLeaveEntitlements,
} from "@/modules/leave/application/services/leave-entitlements.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import {
  CATEGORICAL_TARGETS,
  getCategoricalTargetSpec,
  heuristicMatchCategorical,
  type RowOverrides,
  type ValueMap,
} from "@/lib/ai/csv-value-mapper"

/**
 * Bulk employee import service.
 *
 * Workflow:
 *   1. Parse the uploaded CSV (RFC 4180 quoting).
 *   2. Strip BOM + comment rows (lines starting with `#`).
 *   3. Map header → column index (header cells prefixed with `*` are
 *      the required-tier markers; strip the `*` for matching).
 *   4. Validate every row with Zod and collect per-row errors.
 *   5. Skip only invalid/conflicting rows; clean rows still import.
 *   6. Create/update User + EmployeeProfile + PayrollProfile per row.
 *      Match by email.
 *   7. Return {created, updated, errors}.
 *
 * Default password: `<email><MMDD>` where MMDD is the employee's DOB
 * month + day, zero-padded (e.g. born 23 Nov → `weiming@example.com1123`).
 */

// ─── Validation schema ───────────────────────────────────────────────────

// Case-insensitive token sets. Compared against `t.toLowerCase()` so
// any case mix from the file (TRUE / True / true / TruE) lands the
// same way. Stored as lowercase tokens for that reason.
const TRUE_TOKENS = new Set(["true", "1", "yes", "y", "t"])
const FALSE_TOKENS = new Set(["false", "0", "no", "n", "f"])

const booleanCell = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v == null || v.trim() === "") return null
    // Case-insensitive: covers "True", "TRUE", "true", "Yes", etc.
    // without forcing the upstream heuristic to run first. Without
    // this the schema would reject mixed-case literals from CSV
    // exports where Excel re-cased the values.
    const t = v.trim().toLowerCase()
    if (TRUE_TOKENS.has(t)) return true
    if (FALSE_TOKENS.has(t)) return false
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Expected TRUE/FALSE, got "${v}"`,
    })
    return z.NEVER
  })

const nullableNumber = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v == null || v.trim() === "") return null
    const n = Number(v.trim())
    if (!Number.isFinite(n)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected a number, got "${v}"`,
      })
      return z.NEVER
    }
    return n
  })

const nullableString = z
  .string()
  .optional()
  .transform((v) => {
    if (v == null) return null
    const t = v.trim()
    return t.length > 0 ? t : null
  })

/**
 * Variant of `nullableString` that left-pads purely-numeric values back
 * to a canonical length with zeros. Excel/Google Sheets aggressively
 * strips leading zeros from cells that look numeric when saving as CSV,
 * so admins routinely lose them on fields like IC, SOCSO, SSFW, and
 * postcode (e.g. `000701070280` becomes `701070280`). When the cell is
 * pure digits AND shorter than the canonical length, pad it back.
 *
 * Skipped when the value contains anything other than digits — values
 * with hyphens, letters, or spaces are kept as-is so we never corrupt
 * legitimate non-padded IDs (e.g. EPF "1234-5678" or tax "SG 12345").
 */
function paddedDigitString(canonicalLength: number) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (v == null) return null
      const t = v.trim()
      if (t.length === 0) return null
      if (/^\d+$/.test(t) && t.length < canonicalLength) {
        return t.padStart(canonicalLength, "0")
      }
      return t
    })
}

const requiredString = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().min(1, "Required"))

const dateString = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"))

const nullableDate = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v == null || v.trim() === "") return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected YYYY-MM-DD, got "${v}"`,
      })
      return z.NEVER
    }
    return v.trim()
  })

const nullableEnum = <T extends readonly string[]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v == null || v.trim() === "") return null
      const t = v.trim()
      if (!(values as readonly string[]).includes(t)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expected one of ${values.join(", ")}, got "${v}"`,
        })
        return z.NEVER
      }
      return t as T[number]
    })

const childAbilityStatuses = ["NORMAL", "DISABLED"] as const
// Current studying levels after the July 2026 simplification. Import
// still accepts the legacy set (NONE / PRESCHOOL / PRIMARY / SECONDARY
// / HIGHER_ED) via `normaliseChildStudying` — the parser maps them to
// the new codes so old CSV files keep working.
const childStudyStages = [
  "UNDER_18",
  "PRE_UNIVERSITY",
  "DIPLOMA_MALAYSIA",
  "DEGREE_ABROAD",
] as const
const childPcbDeductions = ["FULL", "HALF", "NONE"] as const

export type ChildReliefEntry = {
  abilityStatus: (typeof childAbilityStatuses)[number] | null
  currentlyStudying: (typeof childStudyStages)[number] | null
  pcbDeduction: (typeof childPcbDeductions)[number] | null
}

const rowSchema = z
  .object({
    // ── Identity & Employment ──
    name: requiredString,
    email: requiredString.pipe(z.string().email("Invalid email")),
    employeeId: requiredString,
    jobTitle: requiredString,
    // Subset of UserRole minus ADMIN. Admins must be created via the
    // admin UI, never via CSV import.
    employeeType: requiredString.pipe(z.enum(importableEmployeeTypes)),
    joinDate: dateString,
    leaveDate: nullableDate,
    archiveReason: nullableString,
    reportedToLhdn: booleanCell,
    // ── Personal & Contact ──
    dateOfBirth: dateString,
    gender: nullableEnum(genders),
    race: nullableString,
    nationality: requiredString,
    maritalStatus: nullableEnum(maritalStatuses),
    hasPr: booleanCell,
    isResident: booleanCell,
    isOku: booleanCell,
    idType: nullableEnum(idTypes),
    // Malaysian NRIC = 12 digits; pad if Excel stripped the leading zeros.
    idNumber: paddedDigitString(12),
    alternateEmail: nullableString,
    // Optional: backs the forgot-password WhatsApp delivery when set.
    // Same validation as the Add-employee dialog — when a value IS
    // provided it must have at least 7 digits after stripping non-digit
    // characters; blank cells become null on PayrollProfile.phone and
    // the admin shares the temporary password manually.
    phone: nullableString.pipe(
      z
        .string()
        .nullable()
        .refine((v) => v === null || v.replace(/\D/g, "").length >= 7, {
          message:
            "Phone number must contain at least 7 digits when provided",
        }),
    ),
    addressLine1: nullableString,
    addressLine2: nullableString,
    addressLine3: nullableString,
    city: nullableString,
    // Malaysian postcode = 5 digits; pad if Excel stripped a leading zero.
    postcode: paddedDigitString(5),
    state: nullableString,
    department: nullableString,
    location: nullableString,
    emergencyContactName: nullableString,
    emergencyContactPhone: nullableString,
    emergencyContactRelation: nullableString,
    // ── Spouse & Dependents (childRelief is folded in separately) ──
    spouseWorking: booleanCell,
    spouseDisabled: booleanCell,
    spousePcbNumber: nullableString,
    spouseIdNumber: nullableString,
    // ── Statutory & Payroll ──
    salaryType: z
      .string()
      .transform((v) => v.trim())
      .pipe(z.enum(salaryTypes)),
    monthlySalary: nullableNumber,
    hourlyRate: nullableNumber,
    contributeToEpf: booleanCell,
    epfNumber: nullableString,
    epfMemberBefore1998: booleanCell,
    epfEmployeeRate: nullableNumber,
    epfEmployeeVoluntary: nullableNumber,
    epfEmployerVoluntary: nullableNumber,
    pcbBorneByEmployer: booleanCell,
    incomeTaxNumber: nullableString,
    socsoScheme: nullableEnum(socsoSchemes),
    // PERKESO SOCSO number = 12 digits (mirrors NRIC); pad if zero-stripped.
    socsoNumber: paddedDigitString(12),
    contributeToEis: booleanCell,
    // SSFW = i-Saraan / EPF self-contribution = 12 digits; same as SOCSO.
    ssfwNumber: paddedDigitString(12),
    // ── Bank ──
    bankName: nullableString,
    bankAccountHolderName: nullableString,
    bankAccountNumber: nullableString,
    paymentMethod: nullableEnum(paymentMethods),
    // ── Hierarchy ──
    // Hierarchy fields are accepted as `nullable` at Zod time so rows
    // with empty hierarchy cells still make it into the preview step.
    // From there the admin uses per-row Policy / Project / Team /
    // Layer pickers to supply the IDs (with inline + Create). The
    // importer's hierarchy block treats a row with no CSV value AND
    // no override as "skip hierarchy assignment for this row".
    //
    // If a row DOES carry CSV values, the importer still resolves
    // them by name; un-resolvable names surface as friendly errors at
    // import time so the admin can use the preview picker to fix
    // them. teamLayer is 1-indexed and clamped against the resolved
    // team's layerCount.
    policyName: nullableString,
    projectCode: nullableString,
    teamCode: nullableString,
    teamLayer: nullableNumber,
    supervisorEmployeeId: nullableString,
  })
  .superRefine((row, ctx) => {
    // Cross-field rule: must have the right salary number for the
    // salary type chosen.
    if (
      row.salaryType === "MONTHLY" &&
      (row.monthlySalary == null || row.monthlySalary < 0)
    ) {
      ctx.addIssue({
        path: ["monthlySalary"],
        code: z.ZodIssueCode.custom,
        message: "monthlySalary >= 0 required when salaryType=MONTHLY",
      })
    }
    if (
      row.salaryType === "HOURLY" &&
      (row.hourlyRate == null || row.hourlyRate < 0)
    ) {
      ctx.addIssue({
        path: ["hourlyRate"],
        code: z.ZodIssueCode.custom,
        message: "hourlyRate >= 0 required when salaryType=HOURLY",
      })
    }
  })

export type ImportRow = z.infer<typeof rowSchema>

/// A parsed row plus optional folded dependent-child entries. The
/// `childN.*` columns are normalised + parsed BEFORE rowSchema runs
/// (the schema itself doesn't know about them), then attached here so
/// the write step can drop the resulting JSON onto PayrollProfile.
export type RowWithChildren = ImportRow & {
  childRelief: ChildReliefEntry[] | null
}

// ─── Dependent-children folding ─────────────────────────────────────────

// `age` is accepted for backward compatibility with older exported
// CSVs — the value is parsed and discarded. Adding a child now
// requires `currentlyStudying`; presence of that key is what makes a
// slot count as populated.
const CHILD_KEY_REGEX =
  /^child(\d+)\.(age|abilityStatus|currentlyStudying|pcbDeduction)$/

/**
 * Pulls all `childN.<subfield>` keys out of `reshaped` (mutating it
 * to remove them) and returns them grouped by N. The keys themselves
 * are deleted so they don't appear in the rowSchema parse.
 */
function extractChildRawSlots(
  reshaped: Record<string, string>,
): Map<number, Record<string, string>> {
  const slots = new Map<number, Record<string, string>>()
  for (const key of Object.keys(reshaped)) {
    const m = key.match(CHILD_KEY_REGEX)
    if (!m) continue
    const n = parseInt(m[1], 10)
    const field = m[2]
    const value = reshaped[key]
    if (!slots.has(n)) slots.set(n, {})
    slots.get(n)![field] = value
    delete reshaped[key]
  }
  return slots
}

/**
 * Take the per-slot raw values and produce a stable JSON array of
 * dependent-child entries. Slots are populated by `currentlyStudying`
 * (the old `age` column is still accepted as a fallback trigger for
 * backward compatibility with older CSVs). Returns null when there
 * are zero children.
 */
function foldChildRelief(
  slots: Map<number, Record<string, string>>,
): ChildReliefEntry[] | null {
  if (slots.size === 0) return null
  const entries: ChildReliefEntry[] = []
  for (const [n, raw] of [...slots.entries()].sort(([a], [b]) => a - b)) {
    const studyingRaw = (raw.currentlyStudying ?? "").trim()
    const ageStr = (raw.age ?? "").trim()
    // A slot counts as populated when at least ONE meaningful field
    // is present. That's usually currentlyStudying but legacy CSVs
    // may drive presence from age alone.
    if (studyingRaw === "" && ageStr === "") continue

    entries.push({
      abilityStatus: normaliseChildAbility(raw.abilityStatus ?? ""),
      currentlyStudying: normaliseChildStudying(studyingRaw, ageStr),
      pcbDeduction: normaliseChildPcbDeduction(raw.pcbDeduction ?? ""),
    })
    // n is used implicitly by the sort order above — not stored on
    // the JSON since the array index already encodes ordering.
    void n
  }
  return entries.length > 0 ? entries : null
}

function normaliseChildAbility(
  raw: string,
): ChildReliefEntry["abilityStatus"] {
  const v = raw.trim().toLowerCase()
  if (v === "") return null
  if (
    v === "normal" ||
    v === "non-disabled" ||
    v === "nondisabled" ||
    v === "not disabled" ||
    v === "able" ||
    v === "n"
  ) {
    return "NORMAL"
  }
  if (v === "disabled" || v === "oku" || v === "yes" || v === "y") {
    return "DISABLED"
  }
  return null
}

/**
 * Coerce the CSV `currentlyStudying` cell into a current-model value.
 *
 * Accepts:
 *   - Current codes: UNDER_18 / PRE_UNIVERSITY / DIPLOMA_MALAYSIA /
 *     DEGREE_ABROAD (case + whitespace insensitive)
 *   - Legacy codes: NONE / PRESCHOOL / PRIMARY / SECONDARY (→ UNDER_18)
 *     and HIGHER_ED (→ DIPLOMA_MALAYSIA — the safer default when the
 *     CSV doesn't say whether the child is studying in or outside
 *     Malaysia; admin can flip to DEGREE_ABROAD via the UI afterwards).
 *   - Human phrases like "pre-university", "diploma malaysia",
 *     "degree overseas", etc.
 *
 * Falls back to UNDER_18 when the cell is blank AND the caller passed
 * an age below 18 (legacy CSV shape). Returns null when there's
 * genuinely no signal to work with.
 */
function normaliseChildStudying(
  raw: string,
  ageFallback: string = "",
): ChildReliefEntry["currentlyStudying"] {
  const v = raw.trim().toLowerCase().replace(/[\s_-]+/g, "")

  // Current codes
  if (v === "under18") return "UNDER_18"
  if (v === "preuniversity" || v === "preuni" || v === "form6" ||
      v === "alevels" || v === "matriculation") {
    return "PRE_UNIVERSITY"
  }
  if (v === "diplomamalaysia" || v === "diplomamy" || v === "diploma" ||
      v === "diplomaorhigher" || v === "diplomaorhighermalaysia") {
    return "DIPLOMA_MALAYSIA"
  }
  if (v === "degreeabroad" || v === "degreeoverseas" || v === "degree" ||
      v === "degreeorhigher" || v === "degreeorhigherabroad" ||
      v === "abroad" || v === "overseas") {
    return "DEGREE_ABROAD"
  }

  // Legacy codes → new codes (matches models.ts normaliseChildStudyingLevel).
  if (v === "none" || v === "notstudying" || v === "no" || v === "n" ||
      v === "preschool" || v === "kindergarten" || v === "nursery" ||
      v === "primary" || v === "elementary" || v === "primaryschool" ||
      v === "secondary" || v === "highschool" || v === "secondaryschool") {
    return "UNDER_18"
  }
  if (v === "highered" || v === "highereducation" || v === "university" ||
      v === "college" || v === "tertiary") {
    return "DIPLOMA_MALAYSIA"
  }

  // Blank cell — infer from age when we have one (legacy CSV shape).
  if (v === "") {
    const age = Number(ageFallback.replace(/[^0-9.]/g, ""))
    if (Number.isFinite(age) && age >= 0) {
      return age < 18 ? "UNDER_18" : "PRE_UNIVERSITY"
    }
    return null
  }

  return null
}

function normaliseChildPcbDeduction(
  raw: string,
): ChildReliefEntry["pcbDeduction"] {
  const v = raw.trim().toLowerCase()
  if (v === "") return null
  if (v === "full" || v === "100" || v === "100%" || v === "1") return "FULL"
  if (v === "half" || v === "50" || v === "50%" || v === "0.5") return "HALF"
  if (v === "none" || v === "0" || v === "0%" || v === "no") return "NONE"
  return null
}

// ─── PayrollProfile write-data builders ─────────────────────────────────
//
// Both the legacy `bulkImportPayrollEmployees` and the AI-mapped
// `importMappedCsv` paths run the same prisma upsert per row. Field
// list is ~60 long, so we centralise it here to avoid the two call
// sites drifting apart.

/**
 * SOCSO scheme to write: caller-supplied value when present;
 * otherwise derived from `dateOfBirth` via the domain recommender.
 * Lets HR upload a CSV without the column and still get the right
 * scheme for the unambiguous age brackets.
 *
 * Returns null for the age 55–59 window — that case depends on whether
 * the employee is a first-time PERKESO registrant, which a blank field
 * in the CSV does NOT reliably indicate (admin may have just left the
 * column out). The admin is expected to pick manually in the
 * Statutory tab after import; the missing-required-field guard will
 * block payroll runs until they do.
 */
function resolveSocsoSchemeForImport(
  row: RowWithChildren,
): "EMPLOYMENT_INJURY_INVALIDITY" | "EMPLOYMENT_INJURY_ONLY" | null {
  if (row.socsoScheme !== null) return row.socsoScheme
  // Pass nationality so foreign workers age 55–59 get Scheme 1
  // automatically (no first-time-registrant ambiguity) per the
  // post-2025 PERKESO expansion. Malaysians 55–59 still return null
  // so the admin picks manually.
  return recommendSocsoScheme({
    dateOfBirth: row.dateOfBirth ? new Date(row.dateOfBirth) : null,
    isMalaysianCitizen: isMalaysianNationality(row.nationality),
  })
}

/**
 * When an import row supplies a `leaveDate` in the PAST, treat the
 * employee as already-archived so they don't sit in the active roster
 * needing a manual click. Otherwise the "Last working day" warning
 * banner nags the admin forever after every historical rehire /
 * bulk-migration import. Returns the archive fields to spread into
 * the create/update payload, or an empty object when no auto-archive
 * applies.
 *
 * Historical (leaveDate is provided AND already before today)
 *   → isArchived: true, archivedAt: now, archiveReason: admin's value
 *     if supplied, else a stock "Imported with past leave date" note.
 * Future / no leaveDate → nothing changes.
 */
function autoArchiveFieldsForImport(row: RowWithChildren): {
  isArchived?: true
  archivedAt?: Date
  archiveReason?: string
} {
  if (!row.leaveDate) return {}
  const leaveDate = new Date(row.leaveDate)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (leaveDate.getTime() >= todayStart.getTime()) return {}
  return {
    isArchived: true,
    archivedAt: now,
    archiveReason: row.archiveReason ?? "Imported with past leave date",
  }
}

function buildPayrollProfileCreate(
  row: RowWithChildren,
  employeeProfileId: string,
) {
  return {
    employeeProfileId,
    salaryType: row.salaryType,
    monthlySalary: row.monthlySalary,
    hourlyRate: row.hourlyRate,
    joinDate: new Date(row.joinDate),
    nationality: row.nationality,
    dateOfBirth: new Date(row.dateOfBirth),
    leaveDate: row.leaveDate ? new Date(row.leaveDate) : null,
    archiveReason: row.archiveReason,
    ...autoArchiveFieldsForImport(row),
    reportedToLhdn: row.reportedToLhdn ?? false,
    gender: row.gender,
    race: row.race,
    maritalStatus: row.maritalStatus,
    hasPr: row.hasPr ?? false,
    isResident: row.isResident ?? true,
    isOku: row.isOku ?? false,
    idType: row.idType ?? "NRIC",
    idNumber: row.idNumber,
    alternateEmail: row.alternateEmail,
    phone: row.phone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    addressLine3: row.addressLine3,
    city: row.city,
    postcode: row.postcode,
    state: row.state,
    department: row.department,
    location: row.location,
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    emergencyContactRelation: row.emergencyContactRelation,
    spouseWorking: row.spouseWorking,
    spouseDisabled: row.spouseDisabled,
    spousePcbNumber: row.spousePcbNumber,
    spouseIdNumber: row.spouseIdNumber,
    contributeToEpf: row.contributeToEpf ?? true,
    epfNumber: row.epfNumber,
    epfMemberBefore1998: row.epfMemberBefore1998 ?? false,
    ...(row.epfEmployeeRate != null
      ? { epfEmployeeRate: row.epfEmployeeRate }
      : {}),
    ...(row.epfEmployeeVoluntary != null
      ? { epfEmployeeVoluntary: row.epfEmployeeVoluntary }
      : {}),
    ...(row.epfEmployerVoluntary != null
      ? { epfEmployerVoluntary: row.epfEmployerVoluntary }
      : {}),
    pcbBorneByEmployer: row.pcbBorneByEmployer ?? false,
    incomeTaxNumber: row.incomeTaxNumber,
    socsoScheme: resolveSocsoSchemeForImport(row),
    // Default SOCSO number to the NRIC / passport when the CSV cell is
    // blank — in MY most employees' SOCSO no. equals their NRIC, and
    // admins almost always want this fallback. Mirrors the "Use ID
    // number" button on the Manage Employee statutory tab.
    socsoNumber: row.socsoNumber ?? row.idNumber,
    contributeToEis: row.contributeToEis ?? true,
    ssfwNumber: row.ssfwNumber,
    bankName: row.bankName,
    bankAccountHolderName: row.bankAccountHolderName ?? row.name,
    bankAccountNumber: row.bankAccountNumber,
    paymentMethod: row.paymentMethod ?? "BANK_TRANSFER",
    payrollDocuments: [],
    ...(row.childRelief != null ? { childRelief: row.childRelief } : {}),
  }
}

function buildPayrollProfileUpdate(row: RowWithChildren) {
  return {
    salaryType: row.salaryType,
    monthlySalary: row.monthlySalary,
    hourlyRate: row.hourlyRate,
    joinDate: new Date(row.joinDate),
    nationality: row.nationality,
    dateOfBirth: new Date(row.dateOfBirth),
    ...(row.leaveDate !== null ? { leaveDate: new Date(row.leaveDate) } : {}),
    // Auto-archive if the (import-supplied) leaveDate is already in
    // the past. Same rule as the create path — see
    // autoArchiveFieldsForImport.
    ...autoArchiveFieldsForImport(row),
    ...(row.archiveReason !== null
      ? { archiveReason: row.archiveReason }
      : {}),
    ...(row.reportedToLhdn !== null
      ? { reportedToLhdn: row.reportedToLhdn }
      : {}),
    ...(row.hasPr !== null ? { hasPr: row.hasPr } : {}),
    ...(row.isResident !== null ? { isResident: row.isResident } : {}),
    ...(row.isOku !== null ? { isOku: row.isOku } : {}),
    ...(row.idType ? { idType: row.idType } : {}),
    ...(row.idNumber !== null ? { idNumber: row.idNumber } : {}),
    ...(row.alternateEmail !== null
      ? { alternateEmail: row.alternateEmail }
      : {}),
    ...(row.phone !== null ? { phone: row.phone } : {}),
    ...(row.gender !== null ? { gender: row.gender } : {}),
    ...(row.race !== null ? { race: row.race } : {}),
    ...(row.maritalStatus !== null
      ? { maritalStatus: row.maritalStatus }
      : {}),
    ...(row.addressLine1 !== null ? { addressLine1: row.addressLine1 } : {}),
    ...(row.addressLine2 !== null ? { addressLine2: row.addressLine2 } : {}),
    ...(row.addressLine3 !== null ? { addressLine3: row.addressLine3 } : {}),
    ...(row.city !== null ? { city: row.city } : {}),
    ...(row.postcode !== null ? { postcode: row.postcode } : {}),
    ...(row.state !== null ? { state: row.state } : {}),
    ...(row.department !== null ? { department: row.department } : {}),
    ...(row.location !== null ? { location: row.location } : {}),
    ...(row.emergencyContactName !== null
      ? { emergencyContactName: row.emergencyContactName }
      : {}),
    ...(row.emergencyContactPhone !== null
      ? { emergencyContactPhone: row.emergencyContactPhone }
      : {}),
    ...(row.emergencyContactRelation !== null
      ? { emergencyContactRelation: row.emergencyContactRelation }
      : {}),
    ...(row.spouseWorking !== null
      ? { spouseWorking: row.spouseWorking }
      : {}),
    ...(row.spouseDisabled !== null
      ? { spouseDisabled: row.spouseDisabled }
      : {}),
    ...(row.spousePcbNumber !== null
      ? { spousePcbNumber: row.spousePcbNumber }
      : {}),
    ...(row.spouseIdNumber !== null
      ? { spouseIdNumber: row.spouseIdNumber }
      : {}),
    ...(row.contributeToEpf !== null
      ? { contributeToEpf: row.contributeToEpf }
      : {}),
    ...(row.epfNumber !== null ? { epfNumber: row.epfNumber } : {}),
    ...(row.epfMemberBefore1998 !== null
      ? { epfMemberBefore1998: row.epfMemberBefore1998 }
      : {}),
    ...(row.epfEmployeeRate != null
      ? { epfEmployeeRate: row.epfEmployeeRate }
      : {}),
    ...(row.epfEmployeeVoluntary != null
      ? { epfEmployeeVoluntary: row.epfEmployeeVoluntary }
      : {}),
    ...(row.epfEmployerVoluntary != null
      ? { epfEmployerVoluntary: row.epfEmployerVoluntary }
      : {}),
    ...(row.pcbBorneByEmployer !== null
      ? { pcbBorneByEmployer: row.pcbBorneByEmployer }
      : {}),
    ...(row.incomeTaxNumber !== null
      ? { incomeTaxNumber: row.incomeTaxNumber }
      : {}),
    // SOCSO scheme: take CSV value if present, else derive from
    // age + socsoNumber. Falls back to omitting the field (preserve
    // existing DB value) when even the derive fails (e.g. DOB
    // missing from this row's CSV).
    ...(() => {
      const resolved = resolveSocsoSchemeForImport(row)
      return resolved !== null ? { socsoScheme: resolved } : {}
    })(),
    // Mirror the create path: blank SOCSO no. in the CSV falls back
    // to the NRIC / passport. Skip the update entirely only when both
    // cells are blank so we don't accidentally overwrite an existing
    // DB value with empty.
    ...(row.socsoNumber !== null
      ? { socsoNumber: row.socsoNumber }
      : row.idNumber !== null
        ? { socsoNumber: row.idNumber }
        : {}),
    ...(row.contributeToEis !== null
      ? { contributeToEis: row.contributeToEis }
      : {}),
    ...(row.ssfwNumber !== null ? { ssfwNumber: row.ssfwNumber } : {}),
    ...(row.bankName !== null ? { bankName: row.bankName } : {}),
    ...(row.bankAccountHolderName !== null
      ? { bankAccountHolderName: row.bankAccountHolderName }
      : {}),
    ...(row.bankAccountNumber !== null
      ? { bankAccountNumber: row.bankAccountNumber }
      : {}),
    ...(row.paymentMethod ? { paymentMethod: row.paymentMethod } : {}),
    // ALWAYS write childRelief on update (don't skip when null). The
    // bulk-upload template always has the childN.* columns; blank
    // cells parse to `null` here, which we treat as "admin cleared
    // the kids" → wipe with []. Skipping the field would silently
    // preserve stale child rows from the previous upload, which is
    // exactly the bug the admin reported: first upload had wrong
    // kids, second upload left them blank, kids should have gone
    // away but stayed.
    childRelief: row.childRelief ?? [],
  }
}

// ─── CSV parser ──────────────────────────────────────────────────────────

/**
 * RFC 4180 CSV parser. Handles:
 *   - Quoted fields with embedded commas, quotes, and newlines
 *   - Doubled `""` quotes inside quoted fields
 *   - CRLF and LF line endings
 *   - Leading BOM
 *   - Comment rows starting with `#`
 */
export function parseCsv(input: string): string[][] {
  let text = input
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ",") {
      row.push(field)
      field = ""
      i += 1
      continue
    }
    if (ch === "\r" || ch === "\n") {
      // End of row.
      row.push(field)
      field = ""
      if (ch === "\r" && text[i + 1] === "\n") i += 2
      else i += 1
      // Skip empty rows + comment rows.
      const first = row[0]?.trim() ?? ""
      if (
        row.length > 1 ||
        (first.length > 0 && !first.startsWith("#"))
      ) {
        if (!first.startsWith("#")) rows.push(row)
      }
      row = []
      continue
    }
    field += ch
    i += 1
  }
  // Flush trailing field/row (no terminating newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    const first = row[0]?.trim() ?? ""
    if (!first.startsWith("#") && row.some((c) => c.trim().length > 0)) {
      rows.push(row)
    }
  }
  return rows
}

// ─── Service ─────────────────────────────────────────────────────────────

export type ImportError = {
  rowNumber: number // 1-based, counting only data rows
  errors: Array<{ field: string; message: string }>
}

export type ImportResult = {
  created: number
  updated: number
  total: number
  errors: ImportError[]
}

// ─── Conflict / error helpers shared by both import flows ───────────────

/**
 * Minimal shape used by `findImportConflicts` — both the
 * Zod-validated `RowWithChildren` and the AI-mapped path's row shape
 * satisfy this.
 */
type ConflictCheckRow = {
  email: string
  employeeId: string
  name?: string
  /// 1-based data-row number from the uploaded CSV. When omitted, the
  /// helper falls back to the array index for legacy callers.
  rowNumber?: number
}

/**
 * Pre-flight check before we write anything. Catches the two
 * duplicate scenarios that would otherwise blow up as raw Prisma
 * P2002 errors:
 *
 *   1. Intra-CSV duplicates — two rows in the upload sharing the same
 *      `employeeId` (or the same email).
 *   2. DB conflicts — `employeeId` is already in use by an
 *      EmployeeProfile that belongs to a DIFFERENT user (someone else
 *      in the org has that code).
 *
 * Returns one `ImportError` per offending row with a clear message
 * the admin can act on, e.g. "Row 3: employee code 'EMP-008' is
 * already assigned to Chan Yan Yee (chan@example.com)."
 *
 * Returns an empty array when the upload is clean.
 */
async function findImportConflicts(input: {
  rows: ConflictCheckRow[]
  prisma: NonNullable<ReturnType<typeof getPrismaClient>>
  organizationId: string
}): Promise<ImportError[]> {
  const { rows, prisma, organizationId } = input
  const errors: ImportError[] = []

  // 1. Intra-CSV: find row indices that share the same `employeeId`.
  //    Same for email. We collect 1-based row numbers and tack the
  //    error onto each offending row so the admin sees both/all.
  const idGroups = new Map<string, number[]>() // employeeId -> rowNumbers
  const emailGroups = new Map<string, number[]>()
  const rowNumberFor = (row: ConflictCheckRow, idx: number) =>
    row.rowNumber ?? idx + 1
  const otherRows = (rowNumbers: number[], rowNumber: number) =>
    rowNumbers.filter((n) => n !== rowNumber).join(", ")

  rows.forEach((row, idx) => {
    const rowNumber = rowNumberFor(row, idx)
    if (row.employeeId) {
      const list = idGroups.get(row.employeeId) ?? []
      list.push(rowNumber)
      idGroups.set(row.employeeId, list)
    }
    if (row.email) {
      const list = emailGroups.get(row.email.toLowerCase()) ?? []
      list.push(rowNumber)
      emailGroups.set(row.email.toLowerCase(), list)
    }
  })
  const rowErrors = new Map<number, Array<{ field: string; message: string }>>()
  const pushRowError = (rowNumber: number, field: string, message: string) => {
    const list = rowErrors.get(rowNumber) ?? []
    list.push({ field, message })
    rowErrors.set(rowNumber, list)
  }
  for (const [employeeId, rowNumbers] of idGroups) {
    if (rowNumbers.length <= 1) continue
    for (const rowNumber of rowNumbers) {
      pushRowError(
        rowNumber,
        "employeeId",
        `Duplicate employee code "${employeeId}" — also appears on row${rowNumbers.length > 2 ? "s" : ""} ${otherRows(rowNumbers, rowNumber)}. This row will be skipped; each imported row must have a unique employee code.`,
      )
    }
  }
  for (const [email, rowNumbers] of emailGroups) {
    if (rowNumbers.length <= 1) continue
    for (const rowNumber of rowNumbers) {
      pushRowError(
        rowNumber,
        "email",
        `Duplicate email "${email}" — also appears on row${rowNumbers.length > 2 ? "s" : ""} ${otherRows(rowNumbers, rowNumber)}. This row will be skipped; each imported row must have a unique email.`,
      )
    }
  }

  // 2a. Multi-org: no cross-org email pre-check. Previously any row
  //     whose email belonged to a user at a DIFFERENT org was rejected
  //     outright. That was the pre-multi-org guard for
  //     `User.email @unique`. Since Phase 1a dropped that constraint
  //     and Phase 6 taught the admin Add-Employee flow to LINK an
  //     existing user into a second company, the importer follows the
  //     same policy — the per-row create loop below checks
  //     `findLinkableExistingUserForOrg` and either links or creates.
  //     Same-org email uniqueness is still enforced (by
  //     `assertEmailAvailableForNewUser` inside the create branch).

  // 2b. DB conflicts: any EmployeeProfile in this org with one of our
  //    employeeIds, attached to a user whose email is NOT in our
  //    upload (= different person).
  const importEmails = new Set(rows.map((r) => r.email.toLowerCase()))
  const importEmployeeIds = Array.from(idGroups.keys())
  if (importEmployeeIds.length > 0) {
    const dbHits = await prisma.employeeProfile.findMany({
      where: {
        employeeId: { in: importEmployeeIds },
        user: { organizationId },
      },
      select: {
        employeeId: true,
        user: { select: { name: true, email: true } },
      },
    })
    const conflictByEmployeeId = new Map<
      string,
      { name: string; email: string }
    >()
    for (const hit of dbHits) {
      if (!hit.user) continue
      if (importEmails.has(hit.user.email.toLowerCase())) continue // same person, will be matched and updated — OK
      conflictByEmployeeId.set(hit.employeeId, {
        name: hit.user.name,
        email: hit.user.email,
      })
    }
    rows.forEach((row, idx) => {
      const conflict = conflictByEmployeeId.get(row.employeeId)
      if (!conflict) return
      pushRowError(
        rowNumberFor(row, idx),
        "employeeId",
        `Employee code "${row.employeeId}" is already assigned to ${conflict.name} (${conflict.email}). This row will be skipped; use a different code, or update that employee by uploading with their email.`,
      )
    })
  }

  // Flatten into ImportError[]
  for (const [rowNumber, fieldErrors] of rowErrors) {
    errors.push({ rowNumber, errors: fieldErrors })
  }
  // Sort by row number for stable output.
  errors.sort((a, b) => a.rowNumber - b.rowNumber)
  return errors
}

/**
 * Translate a Prisma error (or any thrown error) into a single
 * top-level `ImportError` so the UI never has to render a raw stack
 * trace. Use this from the import transactions as a defence-in-depth
 * catch — `findImportConflicts` should already prevent the common
 * P2002 cases.
 */
function translateImportError(err: unknown, rowNumber = 0): ImportError {
  // Prisma's P2002 unique-constraint violation. The `meta.target`
  // array tells us which column(s) collided.
  const e = err as { code?: string; meta?: { target?: string[] | string }; message?: string }
  if (e?.code === "P2002") {
    const target = Array.isArray(e.meta?.target)
      ? e.meta?.target?.join(", ")
      : e.meta?.target ?? "field"
    return {
      rowNumber,
      errors: [
        {
          field: String(target ?? "field"),
          message: `An existing ${target} matches a row in your upload. Please check the file for duplicates and re-upload.`,
        },
      ],
    }
  }
  // Generic fallback — never surface the stack trace or SQL/Prisma text.
  return {
    rowNumber,
    errors: [
      {
        field: "(import)",
        message: safeErrorMessage(
          err,
          "This row could not be imported. Please check the row and try again.",
        ),
      },
    ],
  }
}

function rowNumbersWithErrors(errors: ImportError[]): Set<number> {
  return new Set(errors.map((e) => e.rowNumber).filter((n) => n > 0))
}

/**
 * Pre-load all policies / projects / teams in the org and return
 * case-insensitive name → id maps. Used by both import paths so the
 * per-row hierarchy resolution doesn't depend on the DB's collation
 * for case-insensitive matching ("Fusion" must match "fusion").
 *
 * Takes a Prisma `tx` so it can run inside a transaction — the import
 * resolves references in the same scope it writes employees, so any
 * concurrent admin change is visible.
 */
type HierarchyMaps = {
  policyIdByName: Map<string, string>
  projectIdByName: Map<string, string>
  /** Key = `${lower(projectName)}::${lower(teamName)}` */
  teamByKey: Map<string, { id: string; layerCount: number }>
  /// ID-keyed lookups used by the per-row override path. The wizard
  /// hands us IDs from its preview dropdowns; we validate them against
  /// these sets to defend against stale or cross-org IDs from the
  /// client.
  validPolicyIds: Set<string>
  validProjectIds: Set<string>
  teamById: Map<string, { layerCount: number; projectId: string }>
}

async function loadHierarchyMaps(
  tx: Prisma.TransactionClient | NonNullable<ReturnType<typeof getPrismaClient>>,
  organizationId: string,
): Promise<HierarchyMaps> {
  const [policyRows, projectRows, teamRows] = await Promise.all([
    tx.employeePolicy.findMany({
      where: { organizationId, archivedAt: null },
      select: { id: true, name: true },
    }),
    tx.xeroProject.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    }),
    tx.team.findMany({
      where: { project: { organizationId } },
      select: {
        id: true,
        name: true,
        layerCount: true,
        projectId: true,
        project: { select: { name: true } },
      },
    }),
  ])

  const policyIdByName = new Map<string, string>()
  const validPolicyIds = new Set<string>()
  for (const p of policyRows) {
    policyIdByName.set(p.name.trim().toLowerCase(), p.id)
    validPolicyIds.add(p.id)
  }
  const projectIdByName = new Map<string, string>()
  const validProjectIds = new Set<string>()
  for (const p of projectRows) {
    projectIdByName.set(p.name.trim().toLowerCase(), p.id)
    validProjectIds.add(p.id)
  }
  const teamByKey = new Map<string, { id: string; layerCount: number }>()
  const teamById = new Map<
    string,
    { layerCount: number; projectId: string }
  >()
  for (const t of teamRows) {
    const key = `${t.project.name.trim().toLowerCase()}::${t.name.trim().toLowerCase()}`
    teamByKey.set(key, { id: t.id, layerCount: t.layerCount })
    teamById.set(t.id, { layerCount: t.layerCount, projectId: t.projectId })
  }
  return {
    policyIdByName,
    projectIdByName,
    teamByKey,
    validPolicyIds,
    validProjectIds,
    teamById,
  }
}

/**
 * Parse → validate → write. Invalid/conflicting rows are reported and
 * skipped; clean rows still write.
 */
export async function bulkImportPayrollEmployees(input: {
  csv: string
}): Promise<ImportResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  // Empty-state guard (same as importMappedCsv): refuse to start when
  // the org has no leave types — see comments there.
  const activeLeaveTypeCount = await countActiveLeaveTypesForOrg(orgId)
  if (activeLeaveTypeCount === 0) {
    throw new Error(
      "Set up leave types in Settings → Leave before bulk-importing employees.",
    )
  }
  // The legacy path doesn't carry a per-batch Leave Method from a
  // wizard, so it always uses ORG_DEFAULT seeding.
  const leaveSeed: LeaveSeedInput = { method: "ORG_DEFAULT" }

  // 1. Parse CSV → 2D array of strings.
  const rows = parseCsv(input.csv)
  if (rows.length === 0) {
    throw new Error("CSV is empty.")
  }

  // 2. Header row drives the column index. Strip `*` prefix that
  // marks required columns in the template.
  const header = rows[0].map((cell) => cell.trim().replace(/^\*/, ""))
  const dataRows = rows.slice(1)
  if (dataRows.length === 0) {
    throw new Error("CSV has no data rows.")
  }

  // 3. Build a header → field-name lookup. Unknown headers are
  // silently ignored.
  const colIndex = new Map<string, number>()
  for (const [i, name] of header.entries()) {
    colIndex.set(name, i)
  }

  // 4. Parse + validate each row.
  const errors: ImportError[] = []
  const validRows: Array<{ rowNumber: number; row: RowWithChildren }> = []
  for (const [idx, raw] of dataRows.entries()) {
    const rowNumber = idx + 1
    const obj: Record<string, string> = {}
    for (const [name, ci] of colIndex.entries()) {
      obj[name] = raw[ci] ?? ""
    }
    // Normalise BOOLEAN / DATE / NUMERIC / enum cells the same way
    // the AI-mapped path does, so template uploads with mixed-case
    // booleans / DD/MM/YYYY dates / "11%" percentages parse cleanly.
    const normalised: Record<string, string> = {}
    for (const [key, value] of Object.entries(obj)) {
      normalised[key] = normaliseValue(key, value)
    }
    const childRawSlots = extractChildRawSlots(normalised)
    const parsed = rowSchema.safeParse(normalised)
    if (!parsed.success) {
      errors.push({
        rowNumber,
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "(row)",
          message: issue.message,
        })),
      })
      continue
    }
    validRows.push({
      rowNumber,
      row: {
        ...parsed.data,
        childRelief: foldChildRelief(childRawSlots),
      },
    })
  }

  // 4b. Conflict pre-check — catches intra-CSV duplicates and DB
  // conflicts (e.g. employeeId already assigned to another user) so
  // we surface a friendly error instead of letting Prisma blow up
  // mid-transaction with a P2002 stack trace.
  const conflicts = await findImportConflicts({
    rows: validRows.map(({ rowNumber, row }) => ({
      rowNumber,
      email: row.email,
      employeeId: row.employeeId,
      name: row.name,
    })),
    prisma,
    organizationId: orgId,
  })
  const rowErrors = [...errors, ...conflicts]
  const blockedRows = rowNumbersWithErrors(rowErrors)
  const importRows = validRows.filter((entry) => !blockedRows.has(entry.rowNumber))

  if (importRows.length === 0) {
    return {
      created: 0,
      updated: 0,
      total: dataRows.length,
      errors: rowErrors,
    }
  }

  // 5. Apply rows independently. Bad rows are reported and skipped,
  // while clean rows still land in the database.
  let created = 0
  let updated = 0
  const hierarchy = await loadHierarchyMaps(prisma, orgId)

  for (const { rowNumber, row } of importRows) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
      // Match by email at THIS org first. If a user exists here,
      // this is a same-org update — reuse them.
      const existing = await tx.user.findFirst({
        where: { email: row.email, organizationId: orgId },
        select: {
          id: true,
          role: true,
          employeeProfiles: {
            where: { organizationId: orgId },
            select: { id: true, payrollProfile: { select: { id: true } } },
            take: 1,
          },
        },
      })

      let userId: string
      let outcome: "created" | "updated" | "linked"
      if (existing) {
        // ADMIN/OWNER roles are never overwritten by a CSV import —
        // admin assignment is an admin-UI-only operation and owner is
        // seed/master only. EMPLOYEE and SUPERVISOR rows can flip
        // between each other freely.
        const nextRole =
          existing.role === "ADMIN" || existing.role === "OWNER"
            ? existing.role
            : row.employeeType
        await tx.user.update({
          where: { id: existing.id },
          data: { name: row.name, role: nextRole },
        })
        userId = existing.id
        outcome = "updated"
      } else {
        // Not at this org. Multi-org: check whether this email is an
        // ACTIVE portal user at ANOTHER org. If so, LINK them here
        // (reuse the existing userId, skip the password write so
        // Company A's password stays valid). Otherwise create fresh.
        const linkable = await organizationRepository.findLinkableExistingUserForOrg({
          email: row.email,
          organizationId: orgId,
        })
        if (linkable) {
          userId = linkable.id
          outcome = "linked"
          // Intentionally do NOT rewrite `name`, `role`, or password
          // on the existing User. Password stays whatever they set at
          // their first company — the whole point of the link path.
          // Name / role would silently overwrite Company A's copy
          // (single-scalar columns), so we leave them too.
        } else {
          // New row — validate the email isn't claimed by an active
          // user globally, or by an archived one in THIS org.
          await assertEmailAvailableForNewUser({ email: row.email, orgId })
          const passwordHash = hashPassword(
            defaultPassword(row.email, row.dateOfBirth),
          )
          const u = await tx.user.create({
            data: {
              email: row.email,
              name: row.name,
              role: row.employeeType,
              passwordHash,
              organizationId: orgId,
            },
          })
          userId = u.id
          outcome = "created"
        }
      }

      // EmployeeProfile — scoped to (userId, organizationId).
      // For linked users this creates the FIRST profile at this org;
      // for same-org updates this hits the existing row.
      const epExisting = await tx.employeeProfile.findFirst({
        where: { userId, organizationId: orgId },
        select: { id: true },
      })
      let employeeProfileId: string
      if (epExisting) {
        await tx.employeeProfile.updateMany({
          where: { id: epExisting.id },
          data: { employeeId: row.employeeId, jobTitle: row.jobTitle },
        })
        employeeProfileId = epExisting.id
      } else {
        const ep = await tx.employeeProfile.create({
          data: {
            userId,
            organizationId: orgId,
            employeeId: row.employeeId,
            jobTitle: row.jobTitle,
          },
        })
        employeeProfileId = ep.id
        // Always create the EmployeeOrganization membership row when
        // we're creating a fresh profile — this is what makes the
        // multi-org picker + switcher see them at this org.
        await tx.employeeOrganization.create({
          data: {
            userId,
            employeeProfileId: ep.id,
            organizationId: orgId,
          },
        })
      }

      // PayrollProfile — upsert by employeeProfileId.
      await tx.payrollProfile.upsert({
        where: { employeeProfileId },
        create: buildPayrollProfileCreate(row, employeeProfileId),
        update: buildPayrollProfileUpdate(row),
      })

      // Hierarchy: policy + project + team (mandatory). Resolved via
      // the pre-loaded case-insensitive maps so "Fusion"/"FUSION"/
      // "fusion" all match the same record regardless of DB collation.
      if (row.policyName) {
        const policyId = hierarchy.policyIdByName.get(
          row.policyName.trim().toLowerCase(),
        )
        if (!policyId) {
          throw new Error(
            `Policy "${row.policyName}" not found in this organisation.`,
          )
        }
        await tx.employeeProfile.updateMany({
          where: { id: employeeProfileId },
          data: { policyId },
        })
      }
      if (row.projectCode) {
        const projectId = hierarchy.projectIdByName.get(
          row.projectCode.trim().toLowerCase(),
        )
        if (!projectId) {
          throw new Error(
            `Project "${row.projectCode}" not found in this organisation.`,
          )
        }
        await tx.employeeProjectAssignment.upsert({
          where: {
            employeeProfileId_projectId: {
              employeeProfileId,
              projectId,
            },
          },
          create: { employeeProfileId, projectId },
          update: {},
        })
        if (row.teamCode) {
          const teamKey = `${row.projectCode.trim().toLowerCase()}::${row.teamCode.trim().toLowerCase()}`
          const team = hierarchy.teamByKey.get(teamKey)
          if (!team) {
            throw new Error(
              `Team "${row.teamCode}" not found in project "${row.projectCode}".`,
            )
          }
          const desiredLayer =
            typeof row.teamLayer === "number" && row.teamLayer > 0
              ? Math.min(Math.floor(row.teamLayer), team.layerCount)
              : 1
          await tx.employeeTeamMembership.upsert({
            where: {
              employeeProfileId_teamId: {
                employeeProfileId,
                teamId: team.id,
              },
            },
            create: {
              employeeProfileId,
              teamId: team.id,
              layer: desiredLayer,
            },
            update: { layer: desiredLayer },
          })
        }
      }
        return { outcome, employeeProfileId }
      }, {
        maxWait: 15_000,
        timeout: 120_000,
      })

      if (outcome.outcome === "created" || outcome.outcome === "linked") {
        // "linked" (existing user from another org) counts as a
        // fresh addition at THIS org — the admin sees them for the
        // first time in this org's employee list. Leave-entitlement
        // seeding runs on both paths because Company B needs its
        // own LeaveEntitlement rows regardless.
        created += 1
        try {
          await seedEmployeeLeaveEntitlements({
            employeeProfileId: outcome.employeeProfileId,
            leaveSeed,
          })
        } catch (seedErr) {
          console.error(
            `[payroll-import] leave-seed row ${rowNumber} failed:`,
            seedErr,
          )
        }
      } else updated += 1
    } catch (err) {
      console.error(
        `[payroll-import] bulkImportPayrollEmployees row ${rowNumber} failed:`,
        err,
      )
      rowErrors.push(translateImportError(err, rowNumber))
    }
  }

  // Bust the org-wide hierarchy / employee caches so the Team
  // hierarchy table on /admin/hierarchy + the payroll employees
  // list immediately reflect the newly imported rows.
  if (created > 0 || updated > 0) {
    await bustOrgConfigCaches({ organizationId: orgId })
  }

  return {
    created,
    updated,
    total: dataRows.length,
    errors: rowErrors,
  }
}

/**
 * Derive the default password: `<email><MMDD>` from the employee's
 * DOB. Born 23 Nov → `<email>1123`.
 */
function defaultPassword(email: string, dateOfBirth: string): string {
  const [, month, day] = dateOfBirth.split("-")
  return `${email}${month}${day}`
}

// ─── AI-mapped import flow ──────────────────────────────────────────────

export type SkippedRow = {
  rowNumber: number
  reason: string
}

export type PreviewResult = {
  /// Every normalised row from the file. The admin reviews the
  /// full set in a scrollable table before confirming the import —
  /// previously capped at 5 but admins need to verify the whole batch.
  preview: Array<Record<string, string | null>>
  /// Rows that would be skipped, with their reason.
  skipped: SkippedRow[]
  /// Total data-row count in the file.
  total: number
  /// Per-row Zod validation errors that would block the import.
  errors: ImportError[]
}

export type MappedImportResult = {
  created: number
  updated: number
  total: number
  skipped: SkippedRow[]
  errors: ImportError[]
}

/**
 * Source columns we hide from the AI-mapping wizard. These are
 * legacy template-only column names that historically went through a
 * different code path; they're not in our public schema and have no
 * useful auto-mapping.
 *
 * IMPORTANT: do NOT add column names here that match a schema field
 * key — the wizard will silently swallow those columns, leaving the
 * admin unable to map them. (e.g. `projectcode` and `teamcode` used
 * to be here from the pre-Hierarchy template design and broke the
 * new per-category wizard for any CSV with hierarchy columns.)
 */
const HIDDEN_MAPPED_IMPORT_HEADERS = new Set([
  "department",
  "location",
  "supervisoremployeeid",
])

function normaliseMappedImportHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * For each name set referenced in the CSV, check which already exist
 * in the active org and which are missing. Drives the wizard's
 * RESOLVE step — the admin is asked to create the missing ones (via
 * an inline shortcut) before the import can proceed.
 *
 * Lookups are name-based + case-INSENSITIVE because the CSV is
 * authored in spreadsheets where "QA" and "qa" are usually meant to
 * collide. The matching record's id is returned alongside so the
 * importer can reference it without a second round-trip.
 */
export type ReferenceResolutionResult = {
  policies: {
    existing: Array<{ name: string; id: string; canonicalName: string }>
    missing: string[]
  }
  projects: {
    existing: Array<{ name: string; id: string; canonicalName: string }>
    missing: string[]
  }
  teams: {
    existing: Array<{
      project: string
      team: string
      projectId: string
      teamId: string
      canonicalTeamName: string
    }>
    /**
     * Missing teams may target a project that's ALSO missing — those
     * appear here too so the admin sees "needs a project first" in
     * the UI. The inline create form handles ordering: project must
     * be resolved before its teams can be.
     */
    missing: Array<{ project: string; team: string }>
  }
}

export async function resolveCsvReferences(input: {
  organizationId: string
  references: CsvReferences
}): Promise<ReferenceResolutionResult> {
  const prisma = getPrismaClient()
  if (!prisma) {
    return {
      policies: { existing: [], missing: input.references.policies },
      projects: { existing: [], missing: input.references.projects },
      teams: { existing: [], missing: input.references.teams },
    }
  }

  // Case-insensitive name lookup. We pull every policy/project/team
  // in the org (small N, no need for IN clauses) and bucket in JS.
  const [policyRows, projectRows, teamRows] = await Promise.all([
    prisma.employeePolicy.findMany({
      where: { organizationId: input.organizationId, archivedAt: null },
      select: { id: true, name: true },
    }),
    prisma.xeroProject.findMany({
      where: { organizationId: input.organizationId },
      select: { id: true, name: true },
    }),
    prisma.team.findMany({
      where: { project: { organizationId: input.organizationId } },
      select: {
        id: true,
        name: true,
        project: { select: { id: true, name: true } },
      },
    }),
  ])

  const policyByName = new Map(
    policyRows.map((p) => [p.name.trim().toLowerCase(), p]),
  )
  const projectByName = new Map(
    projectRows.map((p) => [p.name.trim().toLowerCase(), p]),
  )
  const teamByKey = new Map(
    teamRows.map((t) => [
      `${t.project.name.trim().toLowerCase()}::${t.name.trim().toLowerCase()}`,
      t,
    ]),
  )

  const policiesExisting: ReferenceResolutionResult["policies"]["existing"] = []
  const policiesMissing: string[] = []
  for (const name of input.references.policies) {
    const hit = policyByName.get(name.trim().toLowerCase())
    if (hit) {
      policiesExisting.push({ name, id: hit.id, canonicalName: hit.name })
    } else {
      policiesMissing.push(name)
    }
  }

  const projectsExisting: ReferenceResolutionResult["projects"]["existing"] = []
  const projectsMissing: string[] = []
  for (const name of input.references.projects) {
    const hit = projectByName.get(name.trim().toLowerCase())
    if (hit) {
      projectsExisting.push({ name, id: hit.id, canonicalName: hit.name })
    } else {
      projectsMissing.push(name)
    }
  }

  const teamsExisting: ReferenceResolutionResult["teams"]["existing"] = []
  const teamsMissing: ReferenceResolutionResult["teams"]["missing"] = []
  for (const t of input.references.teams) {
    const key = `${t.project.trim().toLowerCase()}::${t.team.trim().toLowerCase()}`
    const hit = teamByKey.get(key)
    if (hit) {
      teamsExisting.push({
        project: t.project,
        team: t.team,
        projectId: hit.project.id,
        teamId: hit.id,
        canonicalTeamName: hit.name,
      })
    } else {
      teamsMissing.push(t)
    }
  }

  return {
    policies: { existing: policiesExisting, missing: policiesMissing },
    projects: { existing: projectsExisting, missing: projectsMissing },
    teams: { existing: teamsExisting, missing: teamsMissing },
  }
}

/**
 * Walk a mapped CSV once and collect the unique policy / project /
 * (project, team) references it touches. Used by the import wizard's
 * RESOLVE step to ask the admin whether each reference exists in the
 * DB and to offer inline-create shortcuts for the ones that don't.
 *
 * No Zod validation runs here — we only care about the raw
 * `policyName`, `projectCode`, `teamCode` values per row. Rows
 * missing any of those simply contribute nothing to the reference
 * set (full-row validation happens later in `previewMappedCsv` /
 * `importMappedCsv` and surfaces those rows as "missing required").
 */
export type CsvReferences = {
  policies: string[]
  projects: string[]
  teams: Array<{ project: string; team: string }>
}

export function extractCsvReferences(input: {
  csv: string
  mapping: Record<string, string | null>
}): CsvReferences {
  const rows = parseCsv(input.csv)
  if (rows.length === 0) {
    return { policies: [], projects: [], teams: [] }
  }
  const sourceHeaders = rows[0].map((c) => c.trim())
  const dataRows = rows.slice(1).filter((row) => {
    const first = row[0]?.trim() ?? ""
    return !first.startsWith("#")
  })

  const sourceIndex = new Map<string, number>()
  for (const [i, h] of sourceHeaders.entries()) {
    sourceIndex.set(h, i)
  }
  // target field → source column index
  function indexFor(target: string): number | null {
    for (const [source, mappedTarget] of Object.entries(input.mapping)) {
      if (mappedTarget === target) {
        return sourceIndex.get(source) ?? null
      }
    }
    return null
  }
  const policyIdx = indexFor("policyName")
  const projectIdx = indexFor("projectCode")
  const teamIdx = indexFor("teamCode")

  const policies = new Set<string>()
  const projects = new Set<string>()
  const teamKey = (p: string, t: string) => `${p}::${t}`
  const teams = new Map<string, { project: string; team: string }>()

  for (const row of dataRows) {
    if (policyIdx != null) {
      const v = (row[policyIdx] ?? "").trim()
      if (v) policies.add(v)
    }
    const project = projectIdx != null ? (row[projectIdx] ?? "").trim() : ""
    if (project) projects.add(project)
    if (teamIdx != null) {
      const team = (row[teamIdx] ?? "").trim()
      // Teams are scoped to a project. Without the project we can't
      // disambiguate (two projects can have a "Backend" team), so we
      // drop the team here. The caller's RESOLVE step will still
      // catch any rows that reference a team without a project via
      // standard "missing required" validation.
      if (project && team) {
        teams.set(teamKey(project, team), { project, team })
      }
    }
  }

  return {
    policies: Array.from(policies).sort((a, b) => a.localeCompare(b)),
    projects: Array.from(projects).sort((a, b) => a.localeCompare(b)),
    teams: Array.from(teams.values()).sort((a, b) =>
      a.project === b.project
        ? a.team.localeCompare(b.team)
        : a.project.localeCompare(b.project),
    ),
  }
}

/**
 * Walk the CSV and collect distinct raw values for every source
 * column whose admin-confirmed target is a categorical (enum/boolean)
 * field. Used to feed the wizard's "Map values" step — the AI is
 * asked to map every distinct raw value to one of our canonical enum
 * values.
 *
 * Columns whose target is non-categorical (free text, numeric, date,
 * reference) are skipped — value mapping does not apply.
 */
export type DistinctValueColumn = {
  target: string
  sourceColumn: string
  rawValues: string[]
}

export function extractCsvDistinctCategoricalValues(input: {
  csv: string
  mapping: Record<string, string | null>
}): DistinctValueColumn[] {
  const rows = parseCsv(input.csv)
  if (rows.length === 0) return []
  const sourceHeaders = rows[0].map((c) => c.trim())
  const dataRows = rows.slice(1).filter((row) => {
    const first = row[0]?.trim() ?? ""
    return !first.startsWith("#")
  })

  const sourceIndex = new Map<string, number>()
  for (const [i, h] of sourceHeaders.entries()) {
    sourceIndex.set(h, i)
  }

  // Walk the mapping and keep only entries whose target is categorical.
  // Multiple source columns can map to the same target — that's
  // unusual but we'd rather merge distinct values than silently drop.
  const perTarget = new Map<
    string,
    { sourceColumn: string; values: Set<string> }
  >()

  for (const [source, target] of Object.entries(input.mapping)) {
    if (!target || target.trim() === "") continue
    if (!(target in CATEGORICAL_TARGETS)) continue
    const idx = sourceIndex.get(source)
    if (idx == null) continue
    const bucket = perTarget.get(target) ?? {
      sourceColumn: source,
      values: new Set<string>(),
    }
    for (const row of dataRows) {
      const v = (row[idx] ?? "").trim()
      if (v !== "") bucket.values.add(v)
    }
    perTarget.set(target, bucket)
  }

  return Array.from(perTarget.entries())
    .map(([target, bucket]) => ({
      target,
      sourceColumn: bucket.sourceColumn,
      rawValues: Array.from(bucket.values).sort((a, b) => a.localeCompare(b)),
    }))
    // Stable display order — categoricals are usually few, alphabetical
    // by target is fine.
    .sort((a, b) => a.target.localeCompare(b.target))
}

/**
 * Pull headers + first 3 sample rows from any uploaded CSV.
 * Used to feed the AI mapper. Doesn't enforce our schema.
 */
export function extractCsvPreview(csv: string): {
  headers: string[]
  sampleRows: string[][]
} {
  const rows = parseCsv(csv)
  if (rows.length === 0) return { headers: [], sampleRows: [] }
  const headerColumns = rows[0]
    .map((c, index) => ({ header: c.trim(), index }))
    .filter(
      (c) =>
        c.header.length > 0 &&
        !HIDDEN_MAPPED_IMPORT_HEADERS.has(
          normaliseMappedImportHeader(c.header),
        ),
    )
  // Skip the description row if it looks like one (#-prefixed first
  // cell) and pull up to 3 actual data rows.
  const dataRows = rows.slice(1).filter((row) => {
    const first = row[0]?.trim() ?? ""
    return !first.startsWith("#")
  })
  return {
    headers: headerColumns.map((c) => c.header),
    sampleRows: dataRows
      .slice(0, 3)
      .map((row) => headerColumns.map((c) => row[c.index] ?? "")),
  }
}

/**
 * Apply the admin-confirmed column mapping to raw rows, normalise
 * the values into our canonical formats, then run the standard Zod
 * validation. Returns parsed rows + per-row skip reasons.
 *
 * The `mapping` arg is keyed by source-column name; the value is the
 * target field key (or null/empty to drop the column entirely).
 */
function reshapeAndNormalize(input: {
  csv: string
  mapping: Record<string, string | null>
  /**
   * Admin-confirmed value-to-enum map from the wizard's "Map values"
   * step. When a target field has an entry for the raw CSV value, the
   * mapped canonical value wins over the importer's hardcoded synonyms.
   * Threaded through here from `previewMappedCsv` / `importMappedCsv`.
   */
  valueMap?: ValueMap
}): {
  parsedRows: Array<{ rowNumber: number; row: RowWithChildren }>
  skipped: SkippedRow[]
  errors: ImportError[]
  total: number
} {
  const rows = parseCsv(input.csv)
  if (rows.length === 0) {
    return { parsedRows: [], skipped: [], errors: [], total: 0 }
  }
  const sourceHeaders = rows[0].map((c) => c.trim())
  const dataRows = rows.slice(1).filter((row) => {
    const first = row[0]?.trim() ?? ""
    return !first.startsWith("#")
  })

  // Build the source column index. If multiple source columns map to
  // the same target, the LAST one wins (admins can dedupe in the UI).
  const sourceIndex = new Map<string, number>()
  for (const [i, h] of sourceHeaders.entries()) {
    sourceIndex.set(h, i)
  }

  // Invert mapping: targetField → source-column index. Filter out
  // empty/null targets.
  const targetToSourceIdx = new Map<string, number>()
  for (const [source, target] of Object.entries(input.mapping)) {
    if (!target || target.trim() === "") continue
    const idx = sourceIndex.get(source)
    if (idx == null) continue
    targetToSourceIdx.set(target, idx)
  }

  const parsedRows: Array<{ rowNumber: number; row: RowWithChildren }> = []
  const skipped: SkippedRow[] = []
  const errors: ImportError[] = []

  for (const [i, rawRow] of dataRows.entries()) {
    // Build raw target-keyed object from the mapping.
    const reshaped: Record<string, string> = {}
    for (const [targetField, srcIdx] of targetToSourceIdx.entries()) {
      reshaped[targetField] = rawRow[srcIdx] ?? ""
    }

    // Normalise each value to the canonical form our Zod schema
    // expects (TRUE/FALSE, YYYY-MM-DD, enum SHOUTING_CASE, etc.).
    // The admin-confirmed `valueMap` wins over the heuristic synonyms.
    const normalised: Record<string, string> = {}
    for (const [key, value] of Object.entries(reshaped)) {
      normalised[key] = normaliseValue(key, value, input.valueMap)
    }

    // Pull child slot fields out before rowSchema runs — they aren't
    // in the schema and would otherwise be silently dropped.
    const childRawSlots = extractChildRawSlots(normalised)

    // Skip rows missing required fields BEFORE Zod runs. Skipped
    // rows don't block the import — they get reported and the
    // remaining rows still write.
    const missingRequired = findMissingRequired(normalised)
    if (missingRequired.length > 0) {
      skipped.push({
        rowNumber: i + 1,
        reason: `Missing required: ${missingRequired.join(", ")}`,
      })
      continue
    }

    const parsed = rowSchema.safeParse(normalised)
    if (!parsed.success) {
      const reason = parsed.error.issues
        .map((issue) => {
          const field = issue.path.join(".") || "(row)"
          return `${field}: ${issue.message}`
        })
        .join("; ")
      skipped.push({
        rowNumber: i + 1,
        reason,
      })
      continue
    }
    parsedRows.push({
      rowNumber: i + 1,
      row: {
        ...parsed.data,
        childRelief: foldChildRelief(childRawSlots),
      },
    })
  }

  return { parsedRows, skipped, errors, total: dataRows.length }
}

const REQUIRED_FIELDS = [
  "name",
  "email",
  "employeeId",
  "jobTitle",
  "employeeType",
  "salaryType",
  "joinDate",
  "nationality",
  "dateOfBirth",
] as const

function findMissingRequired(row: Record<string, string>): string[] {
  const missing: string[] = []
  for (const field of REQUIRED_FIELDS) {
    if (!row[field] || row[field].trim() === "") missing.push(field)
  }
  // Salary-type-dependent extra requirement.
  if (row.salaryType === "MONTHLY" && (!row.monthlySalary || row.monthlySalary.trim() === "")) {
    missing.push("monthlySalary")
  }
  if (row.salaryType === "HOURLY" && (!row.hourlyRate || row.hourlyRate.trim() === "")) {
    missing.push("hourlyRate")
  }
  return missing
}

// ─── Value normalisation ────────────────────────────────────────────────
//
// Categorical fields (enums + booleans) used to live in a giant switch
// here. They now live in `lib/ai/csv-value-mapper.ts` as
// `CATEGORICAL_TARGETS`, so the AI prompt, the UI dropdowns, and the
// importer all read from one source.

const DATE_TARGETS = new Set(["joinDate", "dateOfBirth", "leaveDate"])
const NUMERIC_TARGETS = new Set([
  "monthlySalary",
  "hourlyRate",
  "epfEmployeeRate",
  "epfEmployeeVoluntary",
  "epfEmployerVoluntary",
])

/**
 * Normalise a single cell value for a known target field.
 *
 * Categorical fields (enums + booleans) check the admin-confirmed
 * `valueMap` first; if there's no entry, we fall back to the shared
 * synonym heuristic. Date / numeric paths are unchanged.
 *
 * Returning the raw value (rather than throwing) keeps the existing
 * contract: Zod runs after this and produces a friendly per-row error
 * if normalisation can't recognise the input.
 */
function normaliseValue(
  target: string,
  raw: string,
  valueMap?: ValueMap,
): string {
  const v = (raw ?? "").trim()
  if (v === "") return ""

  // Admin-confirmed value-to-enum mapping wins over everything.
  // Case-insensitive lookup so an admin mapping "True" → "TRUE"
  // also covers cells with "TRUE" / "true" / "TRue" without forcing
  // them to map every case variant individually. Exact match is
  // tried first to keep behaviour deterministic when admins
  // intentionally distinguish casing.
  const targetMap = valueMap?.[target]
  if (targetMap) {
    if (v in targetMap) return targetMap[v] ?? ""
    const vLower = v.toLowerCase()
    for (const [key, canonical] of Object.entries(targetMap)) {
      if (key.toLowerCase() === vLower) return canonical ?? ""
    }
  }

  if (DATE_TARGETS.has(target)) {
    return normaliseDate(v)
  }
  if (NUMERIC_TARGETS.has(target)) {
    return normaliseNumeric(v)
  }
  const spec = getCategoricalTargetSpec(target)
  if (spec) {
    const heuristic = heuristicMatchCategorical(spec, v)
    return heuristic ?? raw
  }
  return v
}

/**
 * Accepts a wide range of date formats and normalises to ISO
 * `YYYY-MM-DD`. Recognises:
 *   - 2026-01-15 (already ISO)
 *   - 15/01/2026  (DD/MM/YYYY — Malaysian convention)
 *   - 15-01-2026
 *   - 15.01.2026
 *   - 01/15/2026  (MM/DD/YYYY — fallback when DD >12 or YYYY first)
 *   - 15 Jan 2026 / Jan 15 2026
 *
 * Returns the raw value if we can't recognise — Zod will then fail
 * the row and the admin sees the error.
 */
function normaliseDate(raw: string): string {
  const v = raw.trim()
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const slashOrDash = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/)
  if (slashOrDash) {
    const a = parseInt(slashOrDash[1], 10)
    const b = parseInt(slashOrDash[2], 10)
    let y = parseInt(slashOrDash[3], 10)
    if (y < 100) y += y >= 50 ? 1900 : 2000
    // Default to DD/MM/YYYY (Malaysian). If the first number is > 12,
    // it MUST be a day, so DD/MM/YYYY is forced. If second > 12 and
    // first ≤ 12, must be MM/DD/YYYY.
    let day = a
    let month = b
    if (a > 12 && b <= 12) {
      day = a
      month = b
    } else if (b > 12 && a <= 12) {
      day = b
      month = a
    } else {
      // Both ≤ 12 → ambiguous, prefer DD/MM/YYYY (Malaysian default).
      day = a
      month = b
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return raw
    return `${y.toString().padStart(4, "0")}-${month
      .toString()
      .padStart(2, "0")}-${day.toString().padStart(2, "0")}`
  }

  // "15 Jan 2026" or "Jan 15 2026" — let Date.parse have a go.
  const t = Date.parse(v)
  if (!Number.isNaN(t)) {
    const d = new Date(t)
    return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1)
      .toString()
      .padStart(2, "0")}-${d.getUTCDate().toString().padStart(2, "0")}`
  }

  return raw
}

function normaliseNumeric(raw: string): string {
  // Strip currency symbols, commas, percent signs, whitespace.
  const cleaned = raw
    .replace(/RM/gi, "")
    .replace(/[$,\s%]/g, "")
    .trim()
  if (cleaned === "") return ""
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return raw
  return String(n)
}

// ─── Preview action ──────────────────────────────────────────────────────

export async function previewMappedCsv(input: {
  csv: string
  mapping: Record<string, string | null>
  /** Optional admin-confirmed value-to-enum map from the wizard. */
  valueMap?: ValueMap
  /**
   * Optional per-row policy/project/team/layer overrides set in the
   * preview step. Accepted here so callers can pass a single `input`
   * shape to both `previewMappedCsv` and `importMappedCsv`; the
   * preview itself does not consume these (the preview is name-based).
   */
  rowOverrides?: RowOverrides
}): Promise<PreviewResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  if (!resolveActiveOrgId(session)) {
    throw new Error("No active organisation.")
  }

  const { parsedRows, skipped, errors, total } = reshapeAndNormalize({
    csv: input.csv,
    mapping: input.mapping,
    valueMap: input.valueMap,
  })

  // Return every parsed row to the preview UI — the admin needs to
  // see exactly what will be imported, not just a sample. The wizard's
  // preview table is scrollable so large imports remain reviewable.
  const preview = parsedRows.map(({ row }) => {
    const obj: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(row)) {
      if (v == null) {
        obj[k] = null
      } else if (k === "childRelief" && Array.isArray(v)) {
        // Compact "n kid(s): UNDER_18 (NORMAL), DIPLOMA_MALAYSIA (NORMAL)"
        // so the admin can sanity-check what got folded without seeing
        // raw JSON in the preview grid.
        obj[k] = (v as ChildReliefEntry[])
          .map(
            (e) =>
              `${e.currentlyStudying ?? "?"}${
                e.abilityStatus ? ` (${e.abilityStatus})` : ""
              }`,
          )
          .join(", ")
      } else if (typeof v === "number") {
        obj[k] = String(v)
      } else {
        obj[k] = String(v)
      }
    }
    return obj
  })

  return { preview, skipped, errors, total }
}

// ─── Import action ───────────────────────────────────────────────────────

export async function importMappedCsv(input: {
  csv: string
  mapping: Record<string, string | null>
  /** Optional admin-confirmed value-to-enum map from the wizard. */
  valueMap?: ValueMap
  /**
   * Optional per-row Policy/Project/Team/Layer overrides from the
   * preview step. When present for a row, the importer uses the IDs
   * directly and skips the CSV-name → DB lookup for that row.
   * Currently accepted but not yet consumed — wired up in a later
   * step of the import-wizard redesign.
   */
  rowOverrides?: RowOverrides
  /**
   * Per-row Leave Method overrides keyed by 0-based preview row
   * index. Rows without an entry use the DEFAULT seeding chain
   * (resolved policy/type defaults). Rows with an entry get the
   * admin-supplied days / methods applied on top.
   *
   * Updated (re-imported) employees are skipped — their existing
   * entitlements are preserved regardless of any entry here.
   */
  leaveSeedByRow?: Record<
    number,
    | { method: "DEFAULT" }
    | { method?: "CUSTOM"; days: Record<string, number>; methods: Record<string, "LUMP_SUM" | "PRO_RATED"> }
  >
}): Promise<MappedImportResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  // Empty-state guard: refuse to start if the org has no leave types.
  // Otherwise newly-imported employees would silently land with zero
  // entitlement rows (lazy-creation gap), and the year-rollover cron
  // would have nothing to roll forward.
  const activeLeaveTypeCount = await countActiveLeaveTypesForOrg(orgId)
  if (activeLeaveTypeCount === 0) {
    throw new Error(
      "Set up leave types in Settings → Leave before bulk-importing employees.",
    )
  }
  // Per-row Leave Method map (keyed by preview row index). Rows
  // without an entry default to `{ method: "ORG_DEFAULT" }` at the
  // seed call below.
  const leaveSeedByRow = input.leaveSeedByRow ?? {}

  const { parsedRows, skipped, errors, total } = reshapeAndNormalize({
    csv: input.csv,
    mapping: input.mapping,
    valueMap: input.valueMap,
  })

  // Conflict pre-check (intra-CSV duplicates + DB collisions). Conflicted
  // rows are skipped, but clean rows still import.
  const conflicts =
    parsedRows.length > 0
      ? await findImportConflicts({
          rows: parsedRows.map(({ rowNumber, row }) => ({
            rowNumber,
            email: row.email,
            employeeId: row.employeeId,
            name: row.name,
          })),
          prisma,
          organizationId: orgId,
        })
      : []
  const rowErrors = [...errors, ...conflicts]
  const blockedRows = rowNumbersWithErrors(rowErrors)
  const importRows = parsedRows
    .map((entry, rowIndex) => ({ ...entry, rowIndex }))
    .filter((entry) => !blockedRows.has(entry.rowNumber))

  let created = 0
  let updated = 0
  const skippedRows = [...skipped]
  const hierarchy = await loadHierarchyMaps(prisma, orgId)

  for (const { rowNumber, row, rowIndex } of importRows) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
      // The wizard's preview is in the same order as `parsedRows`, so
      // `rowOverrides[rowIndex]` is the admin's per-row override for
      // this employee. Per-row IDs win over CSV-name lookups when
      // present; if neither resolves, the row throws below with a
      // friendly message naming the CSV value.
      const override = input.rowOverrides?.[rowIndex]

      const existing = await tx.user.findFirst({
        where: { email: row.email, organizationId: orgId },
        select: {
          id: true,
          role: true,
          employeeProfiles: {
            where: { organizationId: orgId },
            select: { id: true },
            take: 1,
          },
        },
      })

      let userId: string
      let outcome: "created" | "updated" | "linked"
      if (existing) {
        // Update name + role. Role updates are skipped when the
        // existing user is an ADMIN — the CSV can't demote an admin
        // through this path (admins must be managed via the admin
        // UI). For EMPLOYEE/SUPERVISOR rows the role is updated to
        // reflect any change in the CSV.
        const nextRole =
          existing.role === "ADMIN" ? "ADMIN" : row.employeeType
        await tx.user.update({
          where: { id: existing.id },
          data: { name: row.name, role: nextRole },
        })
        userId = existing.id
        outcome = "updated"
      } else {
        // Multi-org: probe for a linkable existing user across ANY
        // org. If found, reuse them WITHOUT rewriting name / role /
        // password. Otherwise create fresh — same as the plain-XLSX
        // importer above.
        const linkable = await organizationRepository.findLinkableExistingUserForOrg({
          email: row.email,
          organizationId: orgId,
        })
        if (linkable) {
          userId = linkable.id
          outcome = "linked"
        } else {
          await assertEmailAvailableForNewUser({ email: row.email, orgId })
          const passwordHash = hashPassword(
            defaultPassword(row.email, row.dateOfBirth),
          )
          const u = await tx.user.create({
            data: {
              email: row.email,
              name: row.name,
              role: row.employeeType,
              passwordHash,
              organizationId: orgId,
            },
          })
          userId = u.id
          outcome = "created"
        }
      }

      // Scope EmployeeProfile lookup to (userId, organizationId) so
      // linked users get a fresh profile at this org.
      const epExisting = await tx.employeeProfile.findFirst({
        where: { userId, organizationId: orgId },
        select: { id: true },
      })
      let employeeProfileId: string
      if (epExisting) {
        await tx.employeeProfile.updateMany({
          where: { id: epExisting.id },
          data: { employeeId: row.employeeId, jobTitle: row.jobTitle },
        })
        employeeProfileId = epExisting.id
      } else {
        const ep = await tx.employeeProfile.create({
          data: {
            userId,
            organizationId: orgId,
            employeeId: row.employeeId,
            jobTitle: row.jobTitle,
          },
        })
        employeeProfileId = ep.id
        // EmployeeOrganization membership row — required for the
        // multi-org picker + Switch Company button to see them.
        await tx.employeeOrganization.create({
          data: {
            userId,
            employeeProfileId: ep.id,
            organizationId: orgId,
          },
        })
      }

      await tx.payrollProfile.upsert({
        where: { employeeProfileId },
        create: buildPayrollProfileCreate(row, employeeProfileId),
        update: buildPayrollProfileUpdate(row),
      })

      // Hierarchy: policy + project + team. Resolution order is
      // (1) per-row override ID from the preview picker → (2) CSV
      // name match → (3) error. The error mentions the picker UI so
      // admins know where to fix it.
      const resolvedPolicyId =
        override?.policyId && hierarchy.validPolicyIds.has(override.policyId)
          ? override.policyId
          : row.policyName
            ? hierarchy.policyIdByName.get(
                row.policyName.trim().toLowerCase(),
              )
            : null

      if (row.policyName || override?.policyId) {
        if (!resolvedPolicyId) {
          throw new Error(
            `Policy "${row.policyName ?? "(unset)"}" not found. Pick or create it in the preview picker.`,
          )
        }
        await tx.employeeProfile.updateMany({
          where: { id: employeeProfileId },
          data: { policyId: resolvedPolicyId },
        })
      }

      const resolvedProjectId =
        override?.projectId && hierarchy.validProjectIds.has(override.projectId)
          ? override.projectId
          : row.projectCode
            ? hierarchy.projectIdByName.get(
                row.projectCode.trim().toLowerCase(),
              )
            : null

      if (row.projectCode || override?.projectId) {
        if (!resolvedProjectId) {
          throw new Error(
            `Project "${row.projectCode ?? "(unset)"}" not found. Pick or create it in the preview picker.`,
          )
        }
        await tx.employeeProjectAssignment.upsert({
          where: {
            employeeProfileId_projectId: {
              employeeProfileId,
              projectId: resolvedProjectId,
            },
          },
          create: { employeeProfileId, projectId: resolvedProjectId },
          update: {},
        })

        // Team: per-row override ID → CSV name + project key → error.
        // Override `teamId` must belong to the resolved project so a
        // stale picker pick can't write a cross-project membership.
        let resolvedTeam: { id: string; layerCount: number } | undefined
        if (override?.teamId) {
          const t = hierarchy.teamById.get(override.teamId)
          if (t && t.projectId === resolvedProjectId) {
            resolvedTeam = { id: override.teamId, layerCount: t.layerCount }
          }
        }
        if (!resolvedTeam && row.teamCode && row.projectCode) {
          const teamKey = `${row.projectCode.trim().toLowerCase()}::${row.teamCode.trim().toLowerCase()}`
          const t = hierarchy.teamByKey.get(teamKey)
          if (t) resolvedTeam = t
        }

        if (row.teamCode || override?.teamId) {
          if (!resolvedTeam) {
            throw new Error(
              `Team "${row.teamCode ?? "(unset)"}" not found in this project. Pick or create it in the preview picker.`,
            )
          }
          // Layer source: override → CSV → 1. Clamp to layerCount so
          // we never write a non-existent layer.
          const desiredLayerRaw =
            typeof override?.teamLayer === "number"
              ? override.teamLayer
              : typeof row.teamLayer === "number" && row.teamLayer > 0
                ? row.teamLayer
                : 1
          const desiredLayer = Math.max(
            1,
            Math.min(Math.floor(desiredLayerRaw), resolvedTeam.layerCount),
          )
          await tx.employeeTeamMembership.upsert({
            where: {
              employeeProfileId_teamId: {
                employeeProfileId,
                teamId: resolvedTeam.id,
              },
            },
            create: {
              employeeProfileId,
              teamId: resolvedTeam.id,
              layer: desiredLayer,
            },
            update: { layer: desiredLayer },
          })
        }
      }
        return { outcome, employeeProfileId }
      }, {
        maxWait: 15_000,
        timeout: 120_000,
      })

      if (outcome.outcome === "created" || outcome.outcome === "linked") {
        // "linked" employees (existing user from another org) get
        // treated as fresh at THIS org — new EmployeeProfile, new
        // leave entitlements — so seed accordingly.
        created += 1
        // Seed leave entitlements for the freshly-created employee.
        // Updated employees are skipped — they already have rows from
        // a previous import / first leave-page visit / Add Employee
        // dialog, and re-seeding would either be a no-op (default mode)
        // or overwrite their existing customs (custom mode).
        //
        // Per-row Leave Method: pick this row's entry from
        // `leaveSeedByRow` if the admin customised it via the popup,
        // otherwise fall back to ORG_DEFAULT seeding.
        const perRow = leaveSeedByRow[rowIndex]
        const leaveSeed: LeaveSeedInput =
          !perRow
            ? { method: "ORG_DEFAULT" }
            : perRow.method === "DEFAULT"
              ? { method: "DEFAULT" }
              : { method: "CUSTOM", overrides: { days: perRow.days ?? {}, methods: perRow.methods ?? {} } }
        try {
          await seedEmployeeLeaveEntitlements({
            employeeProfileId: outcome.employeeProfileId,
            leaveSeed,
          })
        } catch (seedErr) {
          console.error(
            `[payroll-import] leave-seed row ${rowNumber} failed:`,
            seedErr,
          )
          // Don't bail the whole import — log + continue. The employee
          // row still exists; their leave entitlements just fall back
          // to lazy creation. Year-rollover will pick them up.
        }
      } else updated += 1
    } catch (err) {
      console.error(
        `[payroll-import] importMappedCsv row ${rowNumber} failed:`,
        err,
      )
      const importError = translateImportError(err, rowNumber)
      rowErrors.push(importError)
    }
  }

  // Same as `bulkImportPayrollEmployees`: bust the cached hierarchy
  // / employee lists so the new rows show up on the Team hierarchy
  // and payroll employees pages without a manual reload.
  if (created > 0 || updated > 0) {
    await bustOrgConfigCaches({ organizationId: orgId })
  }

  return { created, updated, total, skipped: skippedRows, errors: rowErrors }
}
