import { NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * The `admins` collection — the ADMIN / OWNER users of the organization
 * the calling per-org token belongs to.
 *
 * Auth: per-org `wp_live_*` token for every method here. This route
 * deliberately does NOT live under `/api/v1/admin/*` — that prefix is
 * reserved for master-key provisioning (see `app/api/v1/CLAUDE.md`).
 * `/api/v1/admin/admins` is kept as a backwards-compatible alias.
 */

/**
 * GET /api/v1/admins
 *
 * Required scope: `employees:read`.
 *
 * Lists the ADMIN / OWNER users of the integration's organization.
 *
 * `/employees` deliberately returns only EMPLOYEE + SUPERVISOR rows, so
 * without this endpoint an integrator has no way to discover the
 * `approvedByUserId` that POST /payroll-runs/[id]/approve requires, nor
 * to confirm the org has an admin at all — which POST /claims/[id]/review
 * needs (it 409s when there is none).
 *
 * Includes admins linked to this org either as their primary org or via
 * an AdminOrganization row, matching the in-app admins list.
 *
 * `access.modules` / `access.policyIds` are `null` when the admin has
 * full access — always the case for OWNER.
 *
 * Example:
 *   {
 *     "data": [
 *       {
 *         "id": "ckxxxxxxxxxxxxxxxxxx",
 *         "email": "owner@acme.com",
 *         "name": "Siti Rahman",
 *         "role": "OWNER",
 *         "createdAt": "2026-01-04T02:11:09.001Z",
 *         "access": { "modules": null, "policyIds": null }
 *       }
 *     ],
 *     "total": 1
 *   }
 */
export const GET = handleApiRequest(
  ["employees:read"],
  async (_request, ctx) => {
    const admins = await organizationRepository.listAdminsForOrganization(
      ctx.integration.organizationId,
    )
    return NextResponse.json({
      data: admins,
      total: admins.length,
    })
  },
)

/**
 * POST /api/v1/admins
 *
 * Partner endpoint: add an ADMIN to the organization THIS per-org API
 * token belongs to. Used by Altomate Accounting to grant access to
 * additional team members after the org has been created (the OWNER is
 * provisioned at org-creation time via POST /api/v1/admin/organizations,
 * which is master-key authenticated — not here).
 *
 * Auth: per-org `wp_live_*` token (Authorization: Bearer …). The
 * token's organization is the target. No scopes required for now.
 *
 * Body:
 *   {
 *     email: string,
 *     name: string,
 *     modules?: string[] | null,    // optional access scope; see below
 *     policyIds?: string[] | null,
 *   }
 *
 * Access scope (optional, both default to `null` = full access):
 *   - `modules`: array of module keys this admin can see in the sidebar.
 *     Known keys: claims_personal, claims_company, payroll, leave,
 *     attendance, hierarchy, company_structure, audit_log, settings.
 *     Pass `null` for full access (legacy). Pass `[]` to lock the admin
 *     out of every module (rare; the Executive Overview still renders).
 *   - `policyIds`: array of EmployeePolicy ids this admin can see
 *     employees for. `null` = all policies. `[]` = no employees visible.
 *     Pass the ids from GET /api/v1/policies.
 *
 *   For existing admins (already linked to this org), the access scope
 *   is REPLACED if you pass `modules` or `policyIds`. Omit both to
 *   leave the current scope untouched.
 *
 * Behaviour:
 *   - Brand-new email                 → create User { role: ADMIN } and
 *                                       link via AdminOrganization with
 *                                       the scope (or full access).
 *                                       Returns 201 { created: true,
 *                                       linked: true }.
 *   - Existing ADMIN/OWNER (other org) → link to this org via
 *                                       AdminOrganization with the
 *                                       scope (no role change). Returns
 *                                       200 { created: false,
 *                                       linked: true }.
 *   - Existing ADMIN already on this org → if `modules` or `policyIds`
 *                                       was provided, the scope is
 *                                       REPLACED and we return 200
 *                                       { created: false, linked: false,
 *                                       updated: true }. Otherwise it's
 *                                       a no-op.
 *   - Existing user with role EMPLOYEE / SUPERVISOR → 409 conflict (we
 *                                       refuse to silently promote a
 *                                       non-admin account; the partner
 *                                       should pick a different email or
 *                                       contact us).
 *
 * The new admin signs in via the SSO hand-off (POST
 * /api/v1/sso-ticket), never with a password — we mint an unusable
 * random password just to satisfy the schema.
 */

const accessFieldSchema = z
  .array(z.string().trim().min(1))
  .nullable()
  .optional()

const createAdminSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .email("Enter a valid email.")
    .toLowerCase(),
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(120, "Name is too long."),
  modules: accessFieldSchema,
  policyIds: accessFieldSchema,
})

export const POST = handleApiRequest([], async (request, { integration }) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { status: 400, message: "Invalid JSON body." } },
      { status: 400 },
    )
  }

  const parsed = createAdminSchema.safeParse(body)
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

  const { email, name, modules, policyIds } = parsed.data
  const organizationId = integration.organizationId
  // Did the caller actually try to set scope? Distinguishes "leave the
  // existing scope alone" (omit both fields) from "make it full access"
  // (explicit null). Used below when the admin is already linked.
  const scopeProvided = modules !== undefined || policyIds !== undefined
  const access = scopeProvided
    ? {
        modules: modules ?? null,
        policyIds: policyIds ?? null,
      }
    : undefined

  const existing = await organizationRepository.findUserByEmail(email)

  // Refuse to silently promote a non-admin account into an admin role
  // for this org. Partner should use a fresh email or contact us.
  if (existing && existing.role !== "ADMIN" && existing.role !== "OWNER") {
    void writeAudit({
      organizationId,
      actor: { kind: "PARTNER_API", integrationName: integration.name },
      action: "admin.add",
      status: "FAILED",
      summary: `Tried to add ${email} as admin via partner API`,
      errorReason: `Email belongs to a non-admin user (role: ${existing.role}).`,
      targetType: "user",
      targetId: existing.id,
    })
    return NextResponse.json(
      {
        error: {
          status: 409,
          message:
            "That email belongs to a non-admin user in the system. Use a different email.",
        },
      },
      { status: 409 },
    )
  }

  // Already an admin/owner of THIS org → no-op (idempotent).
  if (existing) {
    const alreadyHere = await organizationRepository.isAdminOfOrganization(
      existing.id,
      organizationId,
    )
    if (alreadyHere) {
      // Idempotent on identity; scope is REPLACED when the caller
      // passes modules / policyIds. Omit both → leave it untouched.
      if (access) {
        await organizationRepository.updateAdminAccess({
          adminId: existing.id,
          organizationId,
          modules: access.modules,
          policyIds: access.policyIds,
        })
        void writeAudit({
          organizationId,
          actor: { kind: "PARTNER_API", integrationName: integration.name },
          action: "admin.access.update",
          status: "SUCCESS",
          summary: `Updated access scope for ${existing.name} (${existing.email}) via partner API`,
          targetType: "user",
          targetId: existing.id,
          metadata: { modules: access.modules, policyIds: access.policyIds },
        })
      }
      return NextResponse.json(
        {
          admin: {
            id: existing.id,
            email: existing.email,
            name: existing.name,
            role: existing.role,
          },
          created: false,
          linked: false,
          updated: Boolean(access),
        },
        { status: 200 },
      )
    }

    // Admin/owner from another org → just add the AdminOrganization
    // row. Don't touch their role or primary organizationId.
    await organizationRepository.linkAdminToOrganization(
      existing.id,
      organizationId,
      access,
    )
    void writeAudit({
      organizationId,
      actor: { kind: "PARTNER_API", integrationName: integration.name },
      action: "admin.add",
      status: "SUCCESS",
      summary: `Added ${existing.name} (${existing.email}) as admin via partner API`,
      targetType: "user",
      targetId: existing.id,
      metadata: {
        existingUser: true,
        role: existing.role,
        ...(access
          ? { modules: access.modules, policyIds: access.policyIds }
          : {}),
      },
    })
    return NextResponse.json(
      {
        admin: {
          id: existing.id,
          email: existing.email,
          name: existing.name,
          role: existing.role,
        },
        created: false,
        linked: true,
      },
      { status: 200 },
    )
  }

  // Brand new email — create the User as ADMIN. The random unusable
  // password matches the pattern in createOwnerForOrganization: SSO is
  // the only sign-in path, so no one ever needs (or can find) this
  // value. createAdminForOrganization throws on email collision —
  // we've already guarded against that above, but we catch defensively.
  const password = randomBytes(24).toString("base64url")
  try {
    const created = await organizationRepository.createAdminForOrganization({
      organizationId,
      email,
      name,
      password,
      access,
    })
    void writeAudit({
      organizationId,
      actor: { kind: "PARTNER_API", integrationName: integration.name },
      action: "admin.add",
      status: "SUCCESS",
      summary: `Created new admin ${created.name} (${created.email}) via partner API`,
      targetType: "user",
      targetId: created.id,
      metadata: {
        newUser: true,
        ...(access
          ? { modules: access.modules, policyIds: access.policyIds }
          : {}),
      },
    })
    return NextResponse.json(
      {
        admin: {
          id: created.id,
          email: created.email,
          name: created.name,
          role: "ADMIN",
        },
        created: true,
        linked: true,
      },
      { status: 201 },
    )
  } catch (err) {
    return NextResponse.json(
      {
        error: {
          status: 500,
          message:
            err instanceof Error ? err.message : "Could not create admin.",
        },
      },
      { status: 500 },
    )
  }
})
