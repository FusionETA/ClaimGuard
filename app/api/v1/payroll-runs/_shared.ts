import { NextResponse } from "next/server"

import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Resolve the human a payroll-run state change is attributed to.
 *
 * The API token identifies an ORGANISATION, not a person, so every
 * transition that records an actor has to be told who it was. Callers
 * may pass a user id or an email — email exists because people (and
 * agents) know colleagues by email, not by cuid — and both converge on
 * one authorisation gate here so there is a single place that decides
 * who is eligible.
 *
 * **This is an assertion, not authentication.** We verify the named
 * person is ELIGIBLE (role ADMIN or OWNER, with access to this org),
 * never that they actually asked for it. The token holder is trusted to
 * report the real actor. Callers acting on someone's behalf must have
 * actually been asked.
 *
 * `findAdminWithAccessToOrg` accepts both routes an admin gains access
 * by — their primary org, or a linked `AdminOrganization` row — so a
 * multi-tenant admin whose home org differs is still recognised.
 */
export type ResolvedActor =
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse }

export async function resolveAdminActor(input: {
  organizationId: string
  userId?: string | null
  email?: string | null
  /// Used in the failure message, e.g. "submitter" / "approver".
  role: string
}): Promise<ResolvedActor> {
  let candidateId = input.userId ?? null
  const email = input.email?.trim().toLowerCase() || null

  if (!candidateId && email) {
    const admins = await organizationRepository.listAdminsForOrganization(
      input.organizationId,
    )
    candidateId = admins.find((a) => a.email.toLowerCase() === email)?.id ?? null
  }

  const actor = candidateId
    ? await organizationRepository.findAdminWithAccessToOrg({
        userId: candidateId,
        organizationId: input.organizationId,
      })
    : null

  if (!actor) {
    // "not found", "not an admin" and "no access to this org" collapse
    // into one message on purpose — distinguishing them would leak org
    // membership to a caller probing with arbitrary emails.
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            status: 403,
            message: `The ${input.role} does not have admin access to this organisation. The user must have role ADMIN or OWNER and be linked to this org as their primary or via AdminOrganization. List valid users with GET /api/v1/admins.`,
          },
        },
        { status: 403 },
      ),
    }
  }

  return { ok: true, userId: actor.id }
}
