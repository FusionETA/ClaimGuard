"use server"

import type { Route } from "next"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { getCurrentSession, updateCurrentSession } from "@/lib/auth/session"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

const switchSchema = z.object({
  organizationId: z.string().min(1, "Pick an organisation."),
})

/**
 * Enter support mode against a target org. Sets the session's
 * `activeOrganizationId` to that org and redirects to the admin
 * dashboard, where the superadmin now sees + acts on that org's
 * data.
 *
 * Gate is enforced at three layers for defence-in-depth:
 *   1. Only a superadmin session gets past the first check here.
 *   2. The org must actually exist (defence against a mangled hidden
 *      form field).
 *   3. `updateCurrentSession` writes the cookie server-side; the
 *      client can't spoof the switch without also spoofing the
 *      HMAC-signed cookie.
 */
export async function enterSupportModeAction(formData: FormData) {
  const session = await getCurrentSession()
  if (!session || !session.isSuperadmin) {
    redirect("/login")
  }

  const parsed = switchSchema.safeParse({
    organizationId: formData.get("organizationId"),
  })
  if (!parsed.success) {
    // No visible form-state surface on this page — malformed inputs
    // just bounce back to the picker. Only a hand-crafted request
    // could trigger this so we don't need a user-friendly error.
    redirect("/admin/support" as Route)
  }

  const target = await organizationRepository.getOrganizationById(
    parsed.data.organizationId,
  )
  if (!target) {
    redirect("/admin/support" as Route)
  }

  // Superadmin sessions don't need an AdminOrganization row for the
  // target — the admin gate accepts them via `isSuperadmin`. We just
  // flip `activeOrganizationId` and let the rest of the app route
  // them like any other admin.
  //
  // `activeXeroConnectionId` is dropped so downstream Xero pages
  // don't try to render a connection that belonged to the previous
  // org and produce empty tables. The connection picker will pin a
  // fresh one on next navigation into a Xero-touching route.
  await updateCurrentSession({
    activeOrganizationId: target.id,
    activeXeroConnectionId: undefined,
  })

  revalidatePath("/admin")
  redirect("/admin")
}

/**
 * Exit support mode: reset `activeOrganizationId` back to the
 * superadmin's home org (Fusioneta) and send them to `/admin`
 * (their own dashboard). Idempotent when they're already home.
 */
export async function exitSupportModeAction() {
  const session = await getCurrentSession()
  if (!session || !session.isSuperadmin) {
    redirect("/login")
  }

  await updateCurrentSession({
    activeOrganizationId: session.organizationId,
    activeXeroConnectionId: undefined,
  })

  revalidatePath("/admin")
  redirect("/admin")
}
