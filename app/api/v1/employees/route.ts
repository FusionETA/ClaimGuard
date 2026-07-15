import { NextResponse } from "next/server"
import { safeErrorMessage } from "@/lib/errors"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { bustOrgConfigCaches } from "@/lib/cache-invalidation"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { Prisma } from "@/generated/prisma/client"

/**
 * Pagination defaults. The list endpoint always returns at most
 * `MAX_LIMIT` rows; the client can page via `?limit=&offset=`.
 */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * GET /api/v1/employees
 *
 * Required scope: `employees:read`.
 * Query params:
 *   - limit  (1..200, default 50)
 *   - offset (default 0)
 *   - role   (EMPLOYEE | SUPERVISOR — optional filter)
 */
export const GET = handleApiRequest(["employees:read"], async (request, ctx) => {
  const url = new URL(request.url)
  const limit = clampInt(url.searchParams.get("limit"), 1, MAX_LIMIT, DEFAULT_LIMIT)
  const offset = clampInt(url.searchParams.get("offset"), 0, 1_000_000, 0)
  const roleFilter = url.searchParams.get("role")

  const all = await organizationRepository.getOrganizationMembers(
    ctx.integration.organizationId,
  )

  const filtered = roleFilter
    ? all.filter((m) => m.role === roleFilter)
    : all
  const slice = filtered.slice(offset, offset + limit)

  return NextResponse.json({
    data: slice.map(toExternalEmployee),
    pagination: {
      total: filtered.length,
      limit,
      offset,
      hasMore: offset + limit < filtered.length,
    },
  })
})

const projectAssignmentSchema = z.object({
  projectId: z.string().min(1),
  teamId: z.string().min(1),
  layer: z.number().int().min(1),
  chainApprovers: z
    .array(z.object({ layer: z.number().int().min(1), userId: z.string().min(1) }))
    .default([]),
})

const childReliefSchema = z.object({
  // Age accepted as an optional field for backward compatibility with
  // integrators still on the pre-July-2026 schema. The value is not
  // used in any calculation and is discarded on the repo write path.
  age: z.number().int().min(0).max(100).optional(),
  abilityStatus: z.enum(["NORMAL", "DISABLED"]).default("NORMAL"),
  currentlyStudying: z
    .enum([
      // Current codes.
      "UNDER_18",
      "PRE_UNIVERSITY",
      "DIPLOMA_MALAYSIA",
      "DEGREE_ABROAD",
      // Legacy codes still accepted for backward compat — mapped to
      // current codes downstream by normaliseChildStudyingLevel.
      "NONE",
      "PRESCHOOL",
      "PRIMARY",
      "SECONDARY",
      "HIGHER_ED",
    ])
    .default("UNDER_18"),
  pcbDeduction: z.enum(["FULL", "HALF", "NONE"]).default("NONE"),
})

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const createEmployeeSchema = z
  .object({
    // ── Account ──────────────────────────────────────────────────────────
    name: z.string().trim().min(2, "Name must be at least 2 characters."),
    email: z.string().trim().toLowerCase().email("Enter a valid email."),
    phone: z
      .string()
      .trim()
      .min(7, "Phone number is required (at least 7 digits).")
      .refine((v) => v.replace(/\D/g, "").length >= 7, {
        message: "Phone number must contain at least 7 digits.",
      }),
    jobTitle: z.string().trim().min(1, "Job title is required."),
    role: z.enum(["EMPLOYEE", "SUPERVISOR"]).default("EMPLOYEE"),
    // Auto-defaulted when omitted: password ← email+MMDD, employeeId ← E###,
    // policyId ← org default policy.
    password: z.string().min(8, "Password must be at least 8 characters.").optional(),
    employeeId: z.string().trim().min(1).optional(),
    policyId: z.string().min(1).optional(),
    projectIds: z.array(z.string()).default([]),
    projectAssignments: z.array(projectAssignmentSchema).default([]),

    // ── Personal (required) ──────────────────────────────────────────────
    gender: z.enum(["MALE", "FEMALE"]),
    dateOfBirth: z.string().regex(ISO_DATE, "Date of birth must be YYYY-MM-DD."),
    idNumber: z.string().trim().min(1, "ID number is required."),
    maritalStatus: z.enum(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"]),
    // PCB number is optional — admins routinely create new joiners
    // before LHDN issues the TIN. PCB calc runs without it; the CP39
    // generator checks it separately at file-build time.
    incomeTaxNumber: z.string().trim().optional(),
    joinDate: z.string().regex(ISO_DATE, "Join date must be YYYY-MM-DD."),

    // ── Personal (optional / defaulted) ──────────────────────────────────
    alternateEmail: z.string().trim().toLowerCase().email().optional(),
    nationality: z.string().trim().min(1).default("Malaysian"),
    race: z.string().trim().max(2).optional(),
    idType: z.enum(["NRIC", "PASSPORT", "ARMY_NO", "POLICE_NO"]).default("NRIC"),
    hasPr: z.boolean().optional(),
    isResident: z.boolean().optional(),
    isOku: z.boolean().default(false),

    // ── Spouse ───────────────────────────────────────────────────────────
    spouseWorking: z.boolean().optional(),
    spouseDisabled: z.boolean().optional(),
    spousePcbNumber: z.string().trim().optional(),
    spouseIdNumber: z.string().trim().optional(),

    // ── Dependent children (up to 10) ────────────────────────────────────
    childRelief: z.array(childReliefSchema).max(10).optional(),

    // ── Compensation (salaryType comes from the policy) ──────────────────
    monthlySalary: z.number().nonnegative().optional(),
    hourlyRate: z.number().nonnegative().optional(),

    // ── Previous employment (TP3) ────────────────────────────────────────
    prevEmploymentYear: z.number().int().optional(),
    prevRemuneration: z.number().nonnegative().optional(),
    prevEpf: z.number().nonnegative().optional(),
    prevPcb: z.number().nonnegative().optional(),
    prevZakat: z.number().nonnegative().optional(),
    prevAllowableDeductions: z.number().nonnegative().optional(),

    // ── Statutory ────────────────────────────────────────────────────────
    contributeToEpf: z.boolean().default(true),
    epfMemberBefore1998: z.boolean().default(false),
    epfNumber: z.string().trim().optional(),
    epfEmployeeVoluntary: z.number().min(0).max(100).optional(),
    epfEmployerVoluntary: z.number().min(0).max(100).optional(),
    socsoScheme: z
      .enum(["EMPLOYMENT_INJURY_INVALIDITY", "EMPLOYMENT_INJURY_ONLY"])
      .optional(),
    socsoNumber: z.string().trim().optional(),
    contributeToEis: z.boolean().default(true),
    /// SKBBK (Skim LINDUNG 24 Jam) — per-employee opt-in for the new
    /// PERKESO scheme (effective 1 Jun 2026). Default false; admin
    /// must explicitly enable per employee. Mirrors the toggle model
    /// used on `contributeToEis`, not the auto-eligibility used by
    /// EPF / SOCSO scheme.
    contributeToSkbbk: z.boolean().default(false),
    ssfwNumber: z.string().trim().optional(),
    paymentMethod: z.enum(["BANK_TRANSFER", "CASH", "CHEQUE"]).default("BANK_TRANSFER"),
    bankName: z.string().trim().optional(),
    bankAccountHolderName: z.string().trim().optional(),
    bankAccountNumber: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.maritalStatus === "MARRIED" && data.spouseWorking === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["spouseWorking"],
        message: "spouseWorking is required when maritalStatus is MARRIED.",
      })
    }
    if (data.contributeToEpf !== false && !data.epfNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["epfNumber"],
        message: "epfNumber is required when contributing to EPF.",
      })
    }
    if (data.socsoScheme && !data.socsoNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["socsoNumber"],
        message: "socsoNumber is required when a SOCSO scheme is set.",
      })
    }
  })

/**
 * POST /api/v1/employees
 *
 * Required scope: `employees:write`.
 *
 * Mirrors the payload shape of the admin "Add hierarchy member" dialog
 * but flattened. Wrap-in-transaction is delegated to the repo
 * (`createOrganizationMember` already uses a Prisma transaction
 * internally).
 *
 * Body:
 *   {
 *     name, email, password, employeeId, role,
 *     jobTitle, policyId,
 *     projectIds: string[],
 *     projectAssignments: [
 *       { projectId, teamId, layer, chainApprovers: [{layer, userId}, ...] }
 *     ]
 *   }
 */
export const POST = handleApiRequest(["employees:write"], async (request, ctx) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { status: 400, message: "Invalid JSON body." } },
      { status: 400 },
    )
  }

  const parsed = createEmployeeSchema.safeParse(body)
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

  const orgId = ctx.integration.organizationId
  const d = parsed.data

  // Resolve the policy (org default when omitted) and require the salary
  // figure that matches its salary type.
  let policy: { id: string; salaryType: "MONTHLY" | "HOURLY" }
  try {
    policy = await organizationRepository.resolvePolicyForCreate(orgId, d.policyId)
  } catch (error) {
    return NextResponse.json(
      { error: { status: 400, message: safeErrorMessage(error, "Invalid policy.") } },
      { status: 400 },
    )
  }
  if (policy.salaryType === "MONTHLY" && d.monthlySalary == null) {
    return NextResponse.json(
      { error: { status: 400, message: "monthlySalary is required for a monthly-salary policy." } },
      { status: 400 },
    )
  }
  if (policy.salaryType === "HOURLY" && d.hourlyRate == null) {
    return NextResponse.json(
      { error: { status: 400, message: "hourlyRate is required for an hourly-rate policy." } },
      { status: 400 },
    )
  }

  // Auto-assign employeeId (E###) and default password (email + MMDD of DOB)
  // when the caller doesn't supply them.
  const employeeId =
    d.employeeId ?? (await organizationRepository.generateNextEmployeeId(orgId))
  const [, mm, dd] = d.dateOfBirth.split("-")
  const password = d.password ?? `${d.email}${mm}${dd}`

  // Extra PayrollProfile fields. phone/salaryType/joinDate/dateOfBirth are set
  // by the dedicated params below; everything else flows through here.
  // `undefined` values are skipped by Prisma, so optional fields stay default.
  // Malaysians are always PR + tax-resident (the UI locks these on); mirror
  // that here so the API can't create an inconsistent Malaysian record.
  const isMalaysian = d.nationality.trim().toLowerCase() === "malaysian"
  const payroll: Prisma.PayrollProfileUpdateInput = {
    gender: d.gender,
    nationality: d.nationality,
    idType: d.idType,
    idNumber: d.idNumber,
    maritalStatus: d.maritalStatus,
    incomeTaxNumber: d.incomeTaxNumber,
    isOku: d.isOku,
    contributeToEpf: d.contributeToEpf,
    epfMemberBefore1998: d.epfMemberBefore1998,
    contributeToEis: d.contributeToEis,
    contributeToSkbbk: d.contributeToSkbbk,
    paymentMethod: d.paymentMethod,
    alternateEmail: d.alternateEmail,
    race: d.race,
    hasPr: isMalaysian ? true : d.hasPr,
    isResident: isMalaysian ? true : d.isResident,
    spouseWorking: d.spouseWorking,
    spouseDisabled: d.spouseDisabled,
    spousePcbNumber: d.spousePcbNumber,
    spouseIdNumber: d.spouseIdNumber,
    monthlySalary: d.monthlySalary,
    hourlyRate: d.hourlyRate,
    prevEmploymentYear: d.prevEmploymentYear,
    prevRemuneration: d.prevRemuneration,
    prevEpf: d.prevEpf,
    prevPcb: d.prevPcb,
    prevZakat: d.prevZakat,
    prevAllowableDeductions: d.prevAllowableDeductions,
    epfNumber: d.epfNumber,
    epfEmployeeVoluntary: d.epfEmployeeVoluntary,
    epfEmployerVoluntary: d.epfEmployerVoluntary,
    socsoScheme: d.socsoScheme,
    socsoNumber: d.socsoNumber,
    ssfwNumber: d.ssfwNumber,
    bankName: d.bankName,
    bankAccountHolderName: d.bankAccountHolderName,
    bankAccountNumber: d.bankAccountNumber,
    ...(d.childRelief !== undefined
      ? { childRelief: d.childRelief as unknown as Prisma.InputJsonValue }
      : {}),
  }

  let created: { id: string; linkedExistingUser?: boolean }
  try {
    created = await organizationRepository.createOrganizationMember({
      name: d.name,
      email: d.email,
      password,
      employeeId,
      role: d.role,
      organizationId: orgId,
      projectIds: d.projectIds,
      jobTitle: d.jobTitle,
      policyId: policy.id,
      phone: d.phone,
      joinDate: new Date(d.joinDate),
      dob: d.dateOfBirth,
      projectAssignments: d.projectAssignments,
      payroll,
    })
  } catch (error) {
    const message = safeErrorMessage(error, "Could not create employee.")
    // Email / employeeId collision surface here — return verbatim.
    return NextResponse.json(
      { error: { status: 409, message } },
      { status: 409 },
    )
  }

  await bustOrgConfigCaches({ organizationId: ctx.integration.organizationId })

  // Return the freshly-projected row so the partner can hydrate their
  // local cache without a follow-up GET. Same pattern PATCH uses — there's
  // no per-id repo method, so we project from the list endpoint's output.
  const all = await organizationRepository.getOrganizationMembers(
    ctx.integration.organizationId,
  )
  const member = all.find((m) => m.id === created.id)

  return NextResponse.json(
    {
      data: member ? toExternalEmployee(member) : { id: created.id },
      // Signal to the caller when we linked an existing user instead
      // of creating one. Partners can surface a different confirmation
      // message and skip mailing the password they submitted (which
      // was ignored — the linked user keeps their existing password).
      ...(created.linkedExistingUser ? { linkedExistingUser: true } : {}),
    },
    {
      status: 201,
      headers: {
        // REST convention: point the partner at the canonical resource URL.
        Location: `/api/v1/employees/${created.id}`,
      },
    },
  )
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * Project the internal `OrganizationMember` shape into the external API
 * contract. Don't leak internal-only fields (cache flags, internal ids
 * that aren't meaningful to integrators, etc).
 */
function toExternalEmployee(member: {
  id: string
  employeeProfileId?: string
  name: string
  email: string
  role: "EMPLOYEE" | "SUPERVISOR"
  employeeId: string
  jobTitle: string
  payoutMethod: string
  otPayoutMethod: string
  policyId?: string
  policyName?: string
  projects: Array<{ id: string; name: string }>
  teams: Array<{
    teamId: string
    teamName: string
    projectId: string
    projectName: string
    layer: number
  }>
}) {
  return {
    id: member.id,
    // EmployeeProfile id — partners need this for
    // POST /api/v1/teams/[id]/members.
    employeeProfileId: member.employeeProfileId ?? null,
    name: member.name,
    email: member.email,
    role: member.role,
    employeeId: member.employeeId,
    jobTitle: member.jobTitle,
    payoutMethod: member.payoutMethod,
    otPayoutMethod: member.otPayoutMethod,
    policy: member.policyId
      ? { id: member.policyId, name: member.policyName ?? null }
      : null,
    projects: member.projects,
    teams: member.teams.map((t) => ({
      teamId: t.teamId,
      teamName: t.teamName,
      projectId: t.projectId,
      projectName: t.projectName,
      layer: t.layer,
    })),
  }
}
