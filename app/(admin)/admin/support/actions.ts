"use server"

import type { Route } from "next"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { getCurrentSession, updateCurrentSession } from "@/lib/auth/session"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import {
  createOwnerWithOrganization,
  updateOrgPlanForSupport,
} from "@/modules/organization/application/services/superadmin-support.service"

const switchSchema = z.object({
  organizationId: z.string().min(1, "Pick an organisation."),
})

const planSchema = z.object({
  organizationId: z.string().min(1),
  plan: z.enum(["DIY", "EXPERT"]),
  tier: z.enum(["FREE", "PAID"]),
  claims: z.boolean(),
  attendance: z.boolean(),
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

/**
 * Superadmin-only: change a company's package (plan + tier) and toggle the
 * Claims / Attendance add-on modules. Called directly from the support
 * picker's "Manage plan" dialog (object arg, not a form). Returns a small
 * result the dialog toasts; the actual change + audit happen in the service.
 */
export async function updateOrgPlanAction(input: {
  organizationId: string
  plan: "DIY" | "EXPERT"
  tier: "FREE" | "PAID"
  claims: boolean
  attendance: boolean
}): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !session.isSuperadmin) {
    return { ok: false, message: "Not authorized." }
  }

  const parsed = planSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: "Invalid plan input." }
  }
  const { organizationId, plan, tier, claims, attendance } = parsed.data

  const addons: string[] = []
  if (claims) addons.push("expense_claim")
  if (attendance) addons.push("clock")

  await updateOrgPlanForSupport({
    organizationId,
    plan,
    // EXPERT has no tier split — store null.
    tier: plan === "EXPERT" ? null : tier,
    addons,
  })

  revalidatePath("/admin/support")
  return { ok: true, message: "Plan updated." }
}

const createCompanySchema = z.object({
  orgName: z.string().trim().min(2, "Company name must be at least 2 characters.").max(120),
  ownerName: z.string().trim().min(1, "Owner name is required.").max(120),
  ownerEmail: z.string().trim().email("Enter a valid owner email.").toLowerCase(),
  password: z.string().min(8, "Password must be at least 8 characters."),
  plan: z.enum(["DIY", "EXPERT"]),
  tier: z.enum(["FREE", "PAID"]),
  claims: z.boolean(),
  attendance: z.boolean(),
})

/**
 * Superadmin-only: provision a brand-new company + its OWNER account
 * (portal login). Called directly from the support page's "Provision new
 * company" form (object arg). The account creation, plan seeding, and
 * audit happen in the service; this gates + validates + revalidates.
 */
export async function createCompanyAction(input: {
  orgName: string
  ownerName: string
  ownerEmail: string
  password: string
  plan: "DIY" | "EXPERT"
  tier: "FREE" | "PAID"
  claims: boolean
  attendance: boolean
}): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !session.isSuperadmin) {
    return { ok: false, message: "Not authorized." }
  }

  const parsed = createCompanySchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }
  const { orgName, ownerName, ownerEmail, password, plan, tier, claims, attendance } =
    parsed.data

  const addons: string[] = []
  if (claims) addons.push("expense_claim")
  if (attendance) addons.push("clock")

  try {
    const result = await createOwnerWithOrganization({
      orgName,
      ownerName,
      ownerEmail,
      password,
      plan,
      tier: plan === "EXPERT" ? null : tier,
      addons,
    })
    revalidatePath("/admin/support")
    return {
      ok: true,
      message: result.ownerCreated
        ? `Created "${result.orgName}" with owner ${result.ownerEmail}.`
        : `Created "${result.orgName}" and linked existing owner ${result.ownerEmail}.`,
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Could not create company.",
    }
  }
}
