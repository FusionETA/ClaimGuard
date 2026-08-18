import { NextResponse } from "next/server"
import { z } from "zod"

import { handleApiRequest } from "@/lib/api-auth"
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * A single admin within the calling token's organization, addressed by
 * email. Sibling to `/api/v1/admins` (list + add).
 *
 * Auth: per-org `wp_live_*` token for both methods.
 * `/api/v1/admin/admins/[email]` is kept as a backwards-compatible alias
 * — see `app/api/v1/CLAUDE.md` for why the canonical path moved out of
 * the `admin/` prefix.
 */

/**
 * PATCH /api/v1/admins/[email]
 *
 * Partner endpoint: update the module + policy access scope for an
 * admin who's already linked to this org. The same shape can be set at
 * add-time via POST /api/v1/admins; this endpoint exists for post-hoc
 * scope edits without re-sending the email/name pair.
 *
 * Auth: per-org `wp_live_*` token (Authorization: Bearer …). The
 * token's organization is implicit; the URL email picks the admin.
 *
 * Body (both fields optional — omit one to leave it as-is):
 *   {
 *     modules?: string[] | null,    // null = full module access
 *     policyIds?: string[] | null,  // null = all policies
 *   }
 *
 * Empty arrays are honoured ("no access" — the admin still sees the
 * Executive Overview but every module-gated page redirects to /admin).
 *
 * Behaviour:
 *   - Email not in the system            → 404.
 *   - Email is not an admin of THIS org   → 404 (same shape so a
 *                                            caller can't probe).
 *   - Email is the OWNER of this org      → 409 (owners always have
 *                                            full access — the scope
 *                                            picker doesn't apply).
 *   - Body has neither field              → 400 (nothing to update;
 *                                            send `modules: null` or
 *                                            `policyIds: null` to
 *                                            explicitly clear).
 *   - Otherwise                           → upsert AdminOrganization
 *                                            row and return the new
 *                                            stored scope.
 */

const accessFieldSchema = z
  .array(z.string().trim().min(1))
  .nullable()
  .optional()

const updateAccessSchema = z
  .object({
    modules: accessFieldSchema,
    policyIds: accessFieldSchema,
  })
  .refine((v) => v.modules !== undefined || v.policyIds !== undefined, {
    message:
      "At least one of `modules` or `policyIds` must be provided (use `null` to clear).",
  })

/**
 * DELETE /api/v1/admins/[email]
 *
 * Partner endpoint: remove an ADMIN from the organization this per-org
 * API token belongs to. Counterpart to POST /api/v1/admins.
 *
 * Auth: per-org `wp_live_*` token (Authorization: Bearer …). The
 * token's organization is the org we're removing the admin from. No
 * scopes required for now.
 *
 * URL param: `email` — URL-encoded email of the admin to remove. The
 * organisation context is fully in the token; the email identifies
 * WHICH admin within that org.
 *
 * Behaviour:
 *   - Email not found in our system            → 404.
 *   - Email is not an admin of THIS org         → 404 (same shape so a
 *                                                 caller can't probe).
 *   - Email is the OWNER of this org            → 409. Owners can't be
 *                                                 removed via the
 *                                                 partner API. (The
 *                                                 owner is the partner's
 *                                                 contact for the org.)
 *   - Otherwise (existing ADMIN linked to this org) → unlink via
 *                                                 AdminOrganization
 *                                                 and return 200.
 *
 * The User row itself is NEVER deleted — if the admin is linked to
 * other orgs (via additional AdminOrganization rows) they keep
 * access to those. If they had this org as their "primary"
 * (`User.organizationId`), the repo helper reassigns to a remaining
 * org or nulls it out.
 */

const paramsSchema = z.object({
  email: z
    .string()
    .min(1, "Email is required.")
    .email("Enter a valid email.")
    .transform((v) => v.trim().toLowerCase()),
})

export const DELETE = handleApiRequest<{ email: string }>(
  [],
  async (_request, { integration, params }) => {
    // Next.js dynamic params already URL-decode the path segment, so
    // raw `params.email` is the decoded address. Validate shape via Zod.
    const parsed = paramsSchema.safeParse({ email: params.email })
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            status: 400,
            message: "Invalid email in path.",
            details: parsed.error.flatten(),
          },
        },
        { status: 400 },
      )
    }

    const email = parsed.data.email
    const organizationId = integration.organizationId

    const user = await organizationRepository.findUserByEmail(email)
    if (!user) {
      return NextResponse.json(
        { error: { status: 404, message: "No admin with that email." } },
        { status: 404 },
      )
    }

    // Owners can't be removed via the partner API — they were the
    // org's contact at provisioning time. Surfacing a distinct 409
    // lets the partner see why instead of getting a generic 404.
    if (user.role === "OWNER") {
      void writeAudit({
        organizationId,
        actor: { kind: "PARTNER_API", integrationName: integration.name },
        action: "admin.remove",
        status: "FAILED",
        summary: `Tried to remove owner ${user.email} via partner API`,
        errorReason: "Owners can't be removed via this endpoint.",
        targetType: "user",
        targetId: user.id,
      })
      return NextResponse.json(
        {
          error: {
            status: 409,
            message:
              "Owners can't be removed via this endpoint. Contact us if the owner needs to be transferred.",
          },
        },
        { status: 409 },
      )
    }

    const isLinked = await organizationRepository.isAdminOfOrganization(
      user.id,
      organizationId,
    )
    if (!isLinked) {
      return NextResponse.json(
        {
          error: {
            status: 404,
            message: "That email is not an admin of this organization.",
          },
        },
        { status: 404 },
      )
    }

    // Unlink + repo handles re-pointing `User.organizationId` to a
    // remaining org (or null) when this org was their primary.
    await organizationRepository.unlinkAdminFromOrganization(
      user.id,
      organizationId,
    )

    void writeAudit({
      organizationId,
      actor: { kind: "PARTNER_API", integrationName: integration.name },
      action: "admin.remove",
      status: "SUCCESS",
      summary: `Removed ${user.name} (${user.email}) as admin via partner API`,
      targetType: "user",
      targetId: user.id,
    })

    return NextResponse.json(
      {
        admin: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
        removed: true,
      },
      { status: 200 },
    )
  },
)

export const PATCH = handleApiRequest<{ email: string }>(
  [],
  async (request, { integration, params }) => {
    const parsed = paramsSchema.safeParse({ email: params.email })
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            status: 400,
            message: "Invalid email in path.",
            details: parsed.error.flatten(),
          },
        },
        { status: 400 },
      )
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json(
        { error: { status: 400, message: "Invalid JSON body." } },
        { status: 400 },
      )
    }

    const parsedBody = updateAccessSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json(
        {
          error: {
            status: 400,
            message: "Validation failed.",
            details: parsedBody.error.flatten(),
          },
        },
        { status: 400 },
      )
    }

    const email = parsed.data.email
    const organizationId = integration.organizationId

    const user = await organizationRepository.findUserByEmail(email)
    if (!user) {
      return NextResponse.json(
        { error: { status: 404, message: "No admin with that email." } },
        { status: 404 },
      )
    }

    // Owners always have full access — scope storage on their
    // AdminOrganization row is unused. Return 409 so partners can't
    // accidentally store data that the app ignores.
    if (user.role === "OWNER") {
      return NextResponse.json(
        {
          error: {
            status: 409,
            message:
              "Owners always have full access; their scope can't be updated.",
          },
        },
        { status: 409 },
      )
    }

    const isLinked = await organizationRepository.isAdminOfOrganization(
      user.id,
      organizationId,
    )
    if (!isLinked) {
      return NextResponse.json(
        {
          error: {
            status: 404,
            message: "That email is not an admin of this organization.",
          },
        },
        { status: 404 },
      )
    }

    // Resolve the merge: the caller may have set only one of the two
    // fields. Read the current state for whichever field they omitted
    // so the upsert doesn't accidentally clobber it.
    const [currentModules, currentPolicyIds] = await Promise.all([
      organizationRepository.getAdminModulesForOrg({
        adminId: user.id,
        organizationId,
        userRole: user.role,
      }),
      organizationRepository.getAdminPolicyIdsForOrg({
        adminId: user.id,
        organizationId,
        userRole: user.role,
      }),
    ])
    const modules =
      parsedBody.data.modules !== undefined
        ? parsedBody.data.modules
        : currentModules
    const policyIds =
      parsedBody.data.policyIds !== undefined
        ? parsedBody.data.policyIds
        : currentPolicyIds

    await organizationRepository.updateAdminAccess({
      adminId: user.id,
      organizationId,
      modules,
      policyIds,
    })

    void writeAudit({
      organizationId,
      actor: { kind: "PARTNER_API", integrationName: integration.name },
      action: "admin.access.update",
      status: "SUCCESS",
      summary: `Updated access scope for ${user.name} (${user.email}) via partner API`,
      targetType: "user",
      targetId: user.id,
      metadata: { modules, policyIds },
    })

    return NextResponse.json(
      {
        admin: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
        access: {
          modules,
          policyIds,
        },
      },
      { status: 200 },
    )
  },
)
