import "server-only"

import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { hashPassword } from "@/lib/auth/password"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { getPrismaClient } from "@/lib/prisma"
import {
  genders,
  idTypes,
  maritalStatuses,
  paymentMethods,
  salaryTypes,
  socsoSchemes,
} from "@/modules/payroll/domain/models"

/**
 * Bulk employee import service.
 *
 * Workflow:
 *   1. Parse the uploaded CSV (RFC 4180 quoting).
 *   2. Strip BOM + comment rows (lines starting with `#`).
 *   3. Map header → column index (header cells prefixed with `*` are
 *      the required-tier markers; strip the `*` for matching).
 *   4. Validate every row with Zod. If ANY row fails Tier 1/2, reject
 *      the whole batch and return per-row errors.
 *   5. If all rows pass, run a single Prisma transaction that creates
 *      or updates User + EmployeeProfile + PayrollProfile per row.
 *      Match by email.
 *   6. Return {created, updated, errors}.
 *
 * Default password: `<email><MMDD>` where MMDD is the employee's DOB
 * month + day, zero-padded (e.g. born 23 Nov → `weiming@example.com1123`).
 */

// ─── Validation schema ───────────────────────────────────────────────────

const TRUE_VALUES = new Set(["TRUE", "true", "1", "YES", "yes", "Y", "y"])
const FALSE_VALUES = new Set(["FALSE", "false", "0", "NO", "no", "N", "n", ""])

const booleanCell = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v == null || v.trim() === "") return null
    const t = v.trim()
    if (TRUE_VALUES.has(t)) return true
    if (FALSE_VALUES.has(t)) return false
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

const rowSchema = z
  .object({
    // Tier 1 — identity
    name: requiredString,
    email: requiredString.pipe(z.string().email("Invalid email")),
    employeeId: requiredString,
    jobTitle: requiredString,
    // Tier 2 — payroll readiness
    salaryType: z
      .string()
      .transform((v) => v.trim())
      .pipe(z.enum(salaryTypes)),
    monthlySalary: nullableNumber,
    hourlyRate: nullableNumber,
    joinDate: dateString,
    nationality: requiredString,
    dateOfBirth: dateString,
    // Tier 3 — statutory
    hasPr: booleanCell,
    idType: nullableEnum(idTypes),
    idNumber: nullableString,
    epfNumber: nullableString,
    epfMemberBefore1998: booleanCell,
    socsoScheme: nullableEnum(socsoSchemes),
    socsoNumber: nullableString,
    contributeToEis: booleanCell,
    incomeTaxNumber: nullableString,
    isResident: booleanCell,
    isOku: booleanCell,
    // Tier 4 — bank
    bankName: nullableString,
    bankAccountHolderName: nullableString,
    bankAccountNumber: nullableString,
    paymentMethod: nullableEnum(paymentMethods),
    // Tier 5 — optional
    phone: nullableString,
    gender: nullableEnum(genders),
    race: nullableString,
    maritalStatus: nullableEnum(maritalStatuses),
    addressLine1: nullableString,
    addressLine2: nullableString,
    city: nullableString,
    postcode: nullableString,
    state: nullableString,
    department: nullableString,
    location: nullableString,
    // Hierarchy
    projectCode: nullableString,
    teamCode: nullableString,
    supervisorEmployeeId: nullableString,
  })
  .superRefine((row, ctx) => {
    // Cross-field rule: must have the right salary number for the
    // salary type chosen.
    if (
      row.salaryType === "MONTHLY" &&
      (row.monthlySalary == null || row.monthlySalary <= 0)
    ) {
      ctx.addIssue({
        path: ["monthlySalary"],
        code: z.ZodIssueCode.custom,
        message: "monthlySalary > 0 required when salaryType=MONTHLY",
      })
    }
    if (
      row.salaryType === "HOURLY" &&
      (row.hourlyRate == null || row.hourlyRate <= 0)
    ) {
      ctx.addIssue({
        path: ["hourlyRate"],
        code: z.ZodIssueCode.custom,
        message: "hourlyRate > 0 required when salaryType=HOURLY",
      })
    }
  })

export type ImportRow = z.infer<typeof rowSchema>

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

/**
 * Parse → validate → write. If ANY row has a validation error, the
 * whole batch is rejected and no DB writes happen.
 */
export async function bulkImportPayrollEmployees(input: {
  csv: string
}): Promise<ImportResult> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

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
  const validRows: ImportRow[] = []
  for (const [idx, raw] of dataRows.entries()) {
    const obj: Record<string, string> = {}
    for (const [name, ci] of colIndex.entries()) {
      obj[name] = raw[ci] ?? ""
    }
    const parsed = rowSchema.safeParse(obj)
    if (!parsed.success) {
      errors.push({
        rowNumber: idx + 1,
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "(row)",
          message: issue.message,
        })),
      })
      continue
    }
    validRows.push(parsed.data)
  }

  if (errors.length > 0) {
    // Reject the whole batch — admin fixes the file and re-uploads.
    return {
      created: 0,
      updated: 0,
      total: dataRows.length,
      errors,
    }
  }

  // 5. Apply all rows atomically.
  let created = 0
  let updated = 0
  await prisma.$transaction(async (tx) => {
    for (const row of validRows) {
      // Match by email (chosen as the only unique key per user
      // decision). If a user exists with this email in this org,
      // update them; otherwise create.
      const existing = await tx.user.findFirst({
        where: { email: row.email, organizationId: orgId },
        select: {
          id: true,
          employeeProfile: {
            select: { id: true, payrollProfile: { select: { id: true } } },
          },
        },
      })

      const passwordHash = hashPassword(defaultPassword(row.email, row.dateOfBirth))

      let userId: string
      if (existing) {
        await tx.user.update({
          where: { id: existing.id },
          data: { name: row.name },
        })
        userId = existing.id
        updated += 1
      } else {
        const u = await tx.user.create({
          data: {
            email: row.email,
            name: row.name,
            role: "EMPLOYEE",
            passwordHash,
            organizationId: orgId,
          },
        })
        userId = u.id
        created += 1
      }

      // EmployeeProfile — match by userId, since EmployeeProfile.userId is unique.
      const epExisting = await tx.employeeProfile.findUnique({
        where: { userId },
        select: { id: true },
      })
      let employeeProfileId: string
      if (epExisting) {
        await tx.employeeProfile.update({
          where: { id: epExisting.id },
          data: { employeeId: row.employeeId, jobTitle: row.jobTitle },
        })
        employeeProfileId = epExisting.id
      } else {
        const ep = await tx.employeeProfile.create({
          data: {
            userId,
            employeeId: row.employeeId,
            jobTitle: row.jobTitle,
          },
        })
        employeeProfileId = ep.id
      }

      // PayrollProfile — upsert by employeeProfileId.
      await tx.payrollProfile.upsert({
        where: { employeeProfileId },
        create: {
          employeeProfileId,
          salaryType: row.salaryType,
          monthlySalary: row.monthlySalary,
          hourlyRate: row.hourlyRate,
          joinDate: new Date(row.joinDate),
          nationality: row.nationality,
          dateOfBirth: new Date(row.dateOfBirth),
          hasPr: row.hasPr ?? false,
          idType: row.idType ?? "NRIC",
          idNumber: row.idNumber,
          epfNumber: row.epfNumber,
          epfMemberBefore1998: row.epfMemberBefore1998 ?? false,
          socsoScheme: row.socsoScheme,
          socsoNumber: row.socsoNumber,
          contributeToEis: row.contributeToEis ?? true,
          incomeTaxNumber: row.incomeTaxNumber,
          isResident: row.isResident ?? true,
          isOku: row.isOku ?? false,
          bankName: row.bankName,
          bankAccountHolderName: row.bankAccountHolderName ?? row.name,
          bankAccountNumber: row.bankAccountNumber,
          paymentMethod: row.paymentMethod ?? "BANK_TRANSFER",
          phone: row.phone,
          gender: row.gender,
          race: row.race,
          maritalStatus: row.maritalStatus,
          addressLine1: row.addressLine1,
          addressLine2: row.addressLine2,
          city: row.city,
          postcode: row.postcode,
          state: row.state,
          department: row.department,
          location: row.location,
          payrollDocuments: [],
        },
        update: {
          salaryType: row.salaryType,
          monthlySalary: row.monthlySalary,
          hourlyRate: row.hourlyRate,
          joinDate: new Date(row.joinDate),
          nationality: row.nationality,
          dateOfBirth: new Date(row.dateOfBirth),
          ...(row.hasPr !== null ? { hasPr: row.hasPr } : {}),
          ...(row.idType ? { idType: row.idType } : {}),
          ...(row.idNumber !== null ? { idNumber: row.idNumber } : {}),
          ...(row.epfNumber !== null ? { epfNumber: row.epfNumber } : {}),
          ...(row.epfMemberBefore1998 !== null
            ? { epfMemberBefore1998: row.epfMemberBefore1998 }
            : {}),
          ...(row.socsoScheme !== null ? { socsoScheme: row.socsoScheme } : {}),
          ...(row.socsoNumber !== null ? { socsoNumber: row.socsoNumber } : {}),
          ...(row.contributeToEis !== null
            ? { contributeToEis: row.contributeToEis }
            : {}),
          ...(row.incomeTaxNumber !== null
            ? { incomeTaxNumber: row.incomeTaxNumber }
            : {}),
          ...(row.isResident !== null ? { isResident: row.isResident } : {}),
          ...(row.isOku !== null ? { isOku: row.isOku } : {}),
          ...(row.bankName !== null ? { bankName: row.bankName } : {}),
          ...(row.bankAccountHolderName !== null
            ? { bankAccountHolderName: row.bankAccountHolderName }
            : {}),
          ...(row.bankAccountNumber !== null
            ? { bankAccountNumber: row.bankAccountNumber }
            : {}),
          ...(row.paymentMethod ? { paymentMethod: row.paymentMethod } : {}),
          ...(row.phone !== null ? { phone: row.phone } : {}),
          ...(row.gender !== null ? { gender: row.gender } : {}),
          ...(row.race !== null ? { race: row.race } : {}),
          ...(row.maritalStatus !== null
            ? { maritalStatus: row.maritalStatus }
            : {}),
          ...(row.addressLine1 !== null
            ? { addressLine1: row.addressLine1 }
            : {}),
          ...(row.addressLine2 !== null
            ? { addressLine2: row.addressLine2 }
            : {}),
          ...(row.city !== null ? { city: row.city } : {}),
          ...(row.postcode !== null ? { postcode: row.postcode } : {}),
          ...(row.state !== null ? { state: row.state } : {}),
          ...(row.department !== null ? { department: row.department } : {}),
          ...(row.location !== null ? { location: row.location } : {}),
        },
      })

      // Hierarchy: project + team assignment (best-effort, silently
      // skip if the project/team doesn't exist). Match by name —
      // XeroProject and Team only have a `name` column, no `code`.
      if (row.projectCode) {
        const project = await tx.xeroProject.findFirst({
          where: { organizationId: orgId, name: row.projectCode },
          select: { id: true },
        })
        if (project) {
          await tx.employeeProjectAssignment.upsert({
            where: {
              employeeProfileId_projectId: {
                employeeProfileId,
                projectId: project.id,
              },
            },
            create: { employeeProfileId, projectId: project.id },
            update: {},
          })
          if (row.teamCode) {
            const team = await tx.team.findUnique({
              where: {
                projectId_name: {
                  projectId: project.id,
                  name: row.teamCode,
                },
              },
              select: { id: true },
            })
            if (team) {
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
                  // Default to the bottom layer (1). Admins can move
                  // them later via the company-structure UI.
                  layer: 1,
                },
                update: {},
              })
            }
          }
        }
      }
    }
  }, {
    // Each row sequentially calls findFirst + create/update + upsert
    // + optional hierarchy upserts — multiplied by N rows, on a
    // remote MySQL with ~150ms round-trip, the default 5s timeout is
    // tight. Lift both `maxWait` and `timeout` so batches up to
    // ~50-100 rows comfortably fit. For larger imports (1000+ rows)
    // we'd want to chunk + commit, but that's a v2 problem.
    maxWait: 15_000,
    timeout: 120_000,
  })

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
    errors: [],
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
  /// First N normalised rows (max 5) — what the admin sees on the
  /// preview screen before they confirm.
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
 * Pull headers + first 3 sample rows from any uploaded CSV.
 * Used to feed the AI mapper. Doesn't enforce our schema.
 */
export function extractCsvPreview(csv: string): {
  headers: string[]
  sampleRows: string[][]
} {
  const rows = parseCsv(csv)
  if (rows.length === 0) return { headers: [], sampleRows: [] }
  const headers = rows[0].map((c) => c.trim())
  // Skip the description row if it looks like one (#-prefixed first
  // cell) and pull up to 3 actual data rows.
  const dataRows = rows.slice(1).filter((row) => {
    const first = row[0]?.trim() ?? ""
    return !first.startsWith("#")
  })
  return { headers, sampleRows: dataRows.slice(0, 3) }
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
}): { parsedRows: ImportRow[]; skipped: SkippedRow[]; errors: ImportError[]; total: number } {
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

  const parsedRows: ImportRow[] = []
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
    const normalised: Record<string, string> = {}
    for (const [key, value] of Object.entries(reshaped)) {
      normalised[key] = normaliseValue(key, value)
    }

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
      errors.push({
        rowNumber: i + 1,
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "(row)",
          message: issue.message,
        })),
      })
      continue
    }
    parsedRows.push(parsed.data)
  }

  return { parsedRows, skipped, errors, total: dataRows.length }
}

const REQUIRED_FIELDS = [
  "name",
  "email",
  "employeeId",
  "jobTitle",
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

const BOOLEAN_TARGETS = new Set([
  "hasPr",
  "epfMemberBefore1998",
  "contributeToEis",
  "isResident",
  "isOku",
])
const DATE_TARGETS = new Set(["joinDate", "dateOfBirth"])
const NUMERIC_TARGETS = new Set(["monthlySalary", "hourlyRate"])

function normaliseValue(target: string, raw: string): string {
  const v = (raw ?? "").trim()
  if (v === "") return ""

  if (BOOLEAN_TARGETS.has(target)) {
    return normaliseBoolean(v)
  }
  if (DATE_TARGETS.has(target)) {
    return normaliseDate(v)
  }
  if (NUMERIC_TARGETS.has(target)) {
    return normaliseNumeric(v)
  }
  switch (target) {
    case "salaryType":
      return normaliseEnum(v, {
        MONTHLY: ["monthly", "month", "m", "salaried"],
        HOURLY: ["hourly", "hour", "h", "per hour"],
      })
    case "gender":
      return normaliseEnum(v, {
        MALE: ["male", "m", "man", "lelaki"],
        FEMALE: ["female", "f", "woman", "perempuan"],
      })
    case "maritalStatus":
      return normaliseEnum(v, {
        SINGLE: ["single", "bujang", "never married"],
        MARRIED: ["married", "kahwin"],
        DIVORCED: ["divorced", "bercerai"],
        WIDOWED: ["widowed", "widow", "balu", "duda"],
      })
    case "idType":
      return normaliseEnum(v, {
        NRIC: ["nric", "ic", "mykad", "kad pengenalan"],
        PASSPORT: ["passport", "pasport"],
        ARMY_NO: ["army", "tentera", "army_no"],
        POLICE_NO: ["police", "polis", "police_no"],
      })
    case "socsoScheme":
      return normaliseEnum(v, {
        EMPLOYMENT_INJURY_INVALIDITY: [
          "employment injury and invalidity",
          "employment injury & invalidity",
          "cat 1",
          "category 1",
          "first category",
          "scheme 1",
        ],
        EMPLOYMENT_INJURY_ONLY: [
          "employment injury only",
          "cat 2",
          "category 2",
          "second category",
          "scheme 2",
        ],
      })
    case "paymentMethod":
      return normaliseEnum(v, {
        BANK_TRANSFER: [
          "bank transfer",
          "bank",
          "transfer",
          "giro",
          "online transfer",
        ],
        CASH: ["cash", "tunai"],
        CHEQUE: ["cheque", "check"],
      })
    default:
      return v
  }
}

function normaliseBoolean(raw: string): string {
  const t = raw.toLowerCase().trim()
  if (["true", "1", "yes", "y", "ya", "active", "tick", "x", "✓"].includes(t)) {
    return "TRUE"
  }
  if (["false", "0", "no", "n", "tidak", "inactive", ""].includes(t)) {
    return "FALSE"
  }
  // Unknown boolean — return as-is and let Zod reject.
  return raw
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
  // Strip currency symbols, commas, whitespace.
  const cleaned = raw
    .replace(/RM/gi, "")
    .replace(/[$,\s]/g, "")
    .trim()
  if (cleaned === "") return ""
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return raw
  return String(n)
}

function normaliseEnum(
  raw: string,
  map: Record<string, string[]>,
): string {
  const v = raw.toLowerCase().trim()
  // Already canonical?
  if (map[raw] != null) return raw
  for (const [canonical, synonyms] of Object.entries(map)) {
    if (canonical.toLowerCase() === v) return canonical
    if (synonyms.some((s) => s.toLowerCase() === v)) return canonical
  }
  // Unknown — return raw, Zod will reject.
  return raw
}

// ─── Preview action ──────────────────────────────────────────────────────

export async function previewMappedCsv(input: {
  csv: string
  mapping: Record<string, string | null>
}): Promise<PreviewResult> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  if (!resolveActiveOrgId(session)) {
    throw new Error("No active organisation.")
  }

  const { parsedRows, skipped, errors, total } = reshapeAndNormalize(input)

  // Pick the first 5 fully-normalised rows for preview.
  const preview = parsedRows.slice(0, 5).map((r) => {
    const obj: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(r)) {
      obj[k] = v == null ? null : typeof v === "number" ? String(v) : String(v)
    }
    return obj
  })

  return { preview, skipped, errors, total }
}

// ─── Import action ───────────────────────────────────────────────────────

export async function importMappedCsv(input: {
  csv: string
  mapping: Record<string, string | null>
}): Promise<MappedImportResult> {
  const session = await getCurrentSession()
  if (!session || session.role !== "ADMIN") {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured.")

  const { parsedRows, skipped, errors, total } = reshapeAndNormalize(input)

  if (errors.length > 0) {
    return { created: 0, updated: 0, total, skipped, errors }
  }

  let created = 0
  let updated = 0
  await prisma.$transaction(async (tx) => {
    for (const row of parsedRows) {
      const existing = await tx.user.findFirst({
        where: { email: row.email, organizationId: orgId },
        select: {
          id: true,
          employeeProfile: { select: { id: true } },
        },
      })

      const passwordHash = hashPassword(
        defaultPassword(row.email, row.dateOfBirth),
      )

      let userId: string
      if (existing) {
        await tx.user.update({
          where: { id: existing.id },
          data: { name: row.name },
        })
        userId = existing.id
        updated += 1
      } else {
        const u = await tx.user.create({
          data: {
            email: row.email,
            name: row.name,
            role: "EMPLOYEE",
            passwordHash,
            organizationId: orgId,
          },
        })
        userId = u.id
        created += 1
      }

      const epExisting = await tx.employeeProfile.findUnique({
        where: { userId },
        select: { id: true },
      })
      let employeeProfileId: string
      if (epExisting) {
        await tx.employeeProfile.update({
          where: { id: epExisting.id },
          data: { employeeId: row.employeeId, jobTitle: row.jobTitle },
        })
        employeeProfileId = epExisting.id
      } else {
        const ep = await tx.employeeProfile.create({
          data: {
            userId,
            employeeId: row.employeeId,
            jobTitle: row.jobTitle,
          },
        })
        employeeProfileId = ep.id
      }

      await tx.payrollProfile.upsert({
        where: { employeeProfileId },
        create: {
          employeeProfileId,
          salaryType: row.salaryType,
          monthlySalary: row.monthlySalary,
          hourlyRate: row.hourlyRate,
          joinDate: new Date(row.joinDate),
          nationality: row.nationality,
          dateOfBirth: new Date(row.dateOfBirth),
          hasPr: row.hasPr ?? false,
          idType: row.idType ?? "NRIC",
          idNumber: row.idNumber,
          epfNumber: row.epfNumber,
          epfMemberBefore1998: row.epfMemberBefore1998 ?? false,
          socsoScheme: row.socsoScheme,
          socsoNumber: row.socsoNumber,
          contributeToEis: row.contributeToEis ?? true,
          incomeTaxNumber: row.incomeTaxNumber,
          isResident: row.isResident ?? true,
          isOku: row.isOku ?? false,
          bankName: row.bankName,
          bankAccountHolderName: row.bankAccountHolderName ?? row.name,
          bankAccountNumber: row.bankAccountNumber,
          paymentMethod: row.paymentMethod ?? "BANK_TRANSFER",
          phone: row.phone,
          gender: row.gender,
          race: row.race,
          maritalStatus: row.maritalStatus,
          addressLine1: row.addressLine1,
          addressLine2: row.addressLine2,
          city: row.city,
          postcode: row.postcode,
          state: row.state,
          department: row.department,
          location: row.location,
          payrollDocuments: [],
        },
        update: {
          salaryType: row.salaryType,
          monthlySalary: row.monthlySalary,
          hourlyRate: row.hourlyRate,
          joinDate: new Date(row.joinDate),
          nationality: row.nationality,
          dateOfBirth: new Date(row.dateOfBirth),
          ...(row.hasPr !== null ? { hasPr: row.hasPr } : {}),
          ...(row.idType ? { idType: row.idType } : {}),
          ...(row.idNumber !== null ? { idNumber: row.idNumber } : {}),
          ...(row.epfNumber !== null ? { epfNumber: row.epfNumber } : {}),
          ...(row.epfMemberBefore1998 !== null
            ? { epfMemberBefore1998: row.epfMemberBefore1998 }
            : {}),
          ...(row.socsoScheme !== null ? { socsoScheme: row.socsoScheme } : {}),
          ...(row.socsoNumber !== null ? { socsoNumber: row.socsoNumber } : {}),
          ...(row.contributeToEis !== null
            ? { contributeToEis: row.contributeToEis }
            : {}),
          ...(row.incomeTaxNumber !== null
            ? { incomeTaxNumber: row.incomeTaxNumber }
            : {}),
          ...(row.isResident !== null ? { isResident: row.isResident } : {}),
          ...(row.isOku !== null ? { isOku: row.isOku } : {}),
          ...(row.bankName !== null ? { bankName: row.bankName } : {}),
          ...(row.bankAccountHolderName !== null
            ? { bankAccountHolderName: row.bankAccountHolderName }
            : {}),
          ...(row.bankAccountNumber !== null
            ? { bankAccountNumber: row.bankAccountNumber }
            : {}),
          ...(row.paymentMethod ? { paymentMethod: row.paymentMethod } : {}),
          ...(row.phone !== null ? { phone: row.phone } : {}),
          ...(row.gender !== null ? { gender: row.gender } : {}),
          ...(row.race !== null ? { race: row.race } : {}),
          ...(row.maritalStatus !== null
            ? { maritalStatus: row.maritalStatus }
            : {}),
          ...(row.addressLine1 !== null
            ? { addressLine1: row.addressLine1 }
            : {}),
          ...(row.addressLine2 !== null
            ? { addressLine2: row.addressLine2 }
            : {}),
          ...(row.city !== null ? { city: row.city } : {}),
          ...(row.postcode !== null ? { postcode: row.postcode } : {}),
          ...(row.state !== null ? { state: row.state } : {}),
          ...(row.department !== null ? { department: row.department } : {}),
          ...(row.location !== null ? { location: row.location } : {}),
        },
      })

      // Hierarchy: project + team (best-effort).
      if (row.projectCode) {
        const project = await tx.xeroProject.findFirst({
          where: { organizationId: orgId, name: row.projectCode },
          select: { id: true },
        })
        if (project) {
          await tx.employeeProjectAssignment.upsert({
            where: {
              employeeProfileId_projectId: {
                employeeProfileId,
                projectId: project.id,
              },
            },
            create: { employeeProfileId, projectId: project.id },
            update: {},
          })
          if (row.teamCode) {
            const team = await tx.team.findUnique({
              where: {
                projectId_name: {
                  projectId: project.id,
                  name: row.teamCode,
                },
              },
              select: { id: true },
            })
            if (team) {
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
                  layer: 1,
                },
                update: {},
              })
            }
          }
        }
      }
    }
  }, {
    // See `bulkImportPayrollEmployees` for the rationale on these
    // limits — long-running interactive transaction on a remote
    // MySQL with sequential per-row writes.
    maxWait: 15_000,
    timeout: 120_000,
  })

  // Same as `bulkImportPayrollEmployees`: bust the cached hierarchy
  // / employee lists so the new rows show up on the Team hierarchy
  // and payroll employees pages without a manual reload.
  if (created > 0 || updated > 0) {
    await bustOrgConfigCaches({ organizationId: orgId })
  }

  return { created, updated, total, skipped, errors: [] }
}
