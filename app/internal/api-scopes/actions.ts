"use server"

import { revalidatePath } from "next/cache"

import { API_SCOPE_CATALOG, isKnownApiScope } from "@/lib/api-scopes"
import { apiIntegrationRepository } from "@/modules/organization/infrastructure/api-integration.repository"
import {
  clearInternalUnlockedCookie,
  isInternalUnlocked,
  setInternalUnlockedCookie,
  verifyInternalPassword,
} from "@/app/internal/api-scopes/internal-auth"
import {
  initialInternalUnlockState,
  initialScopeUpdateState,
  type InternalUnlockState,
  type ScopeUpdateState,
} from "@/app/internal/api-scopes/form-state"

/**
 * Verifies the password and (on match) sets the unlock cookie.
 *
 * Always returns through the FormState shape so the form can render
 * an inline error. Empty / wrong password reads back as a friendly
 * "Wrong password" without leaking whether the password was empty vs.
 * non-empty mismatch (treat all failures the same).
 */
export async function unlockAction(
  _prev: InternalUnlockState,
  formData: FormData,
): Promise<InternalUnlockState> {
  const password = String(formData.get("password") ?? "")
  if (!verifyInternalPassword(password)) {
    return {
      status: "error",
      message: "Wrong password.",
    }
  }
  await setInternalUnlockedCookie()
  revalidatePath("/internal/api-scopes")
  return { status: "success", message: "Unlocked." }
}

/**
 * Clear-cookie action for the "Lock" button. Idempotent.
 */
export async function lockAction(): Promise<void> {
  await clearInternalUnlockedCookie()
  revalidatePath("/internal/api-scopes")
}

/**
 * Overwrite one token's scope list. The page renders a checkbox per
 * scope so submitted FormData has zero-or-more `scopes` entries.
 *
 * Defence in depth:
 *   1. Must be unlocked (cookie present). If not, refuse silently —
 *      a stale tab posting after lockout shouldn't make changes.
 *   2. Every submitted scope must be in `API_SCOPE_CATALOG`. Unknown
 *      values are dropped (not error'd — keeps the UX forgiving).
 *   3. Token id is opaque; repo's updateMany scopes by id so the
 *      operation no-ops if someone forges a bogus id.
 */
export async function updateTokenScopesAction(
  _prev: ScopeUpdateState,
  formData: FormData,
): Promise<ScopeUpdateState> {
  const unlocked = await isInternalUnlocked()
  if (!unlocked) {
    return {
      status: "error",
      message: "Session expired. Reload + re-enter the password.",
      tokenId: null,
    }
  }
  const tokenId = String(formData.get("tokenId") ?? "").trim()
  if (!tokenId) {
    return {
      status: "error",
      message: "Missing token id.",
      tokenId: null,
    }
  }
  // Collect scopes from FormData. The form ticks/unticks per scope so
  // any unchecked value just doesn't appear here.
  const raw = formData.getAll("scopes").map(String)
  const scopes = raw.filter(isKnownApiScope)

  // Order canonically so the persisted JSON matches API_SCOPE_CATALOG —
  // makes diffing two tokens trivial.
  const ordered = API_SCOPE_CATALOG.filter((s) => scopes.includes(s))

  const result = await apiIntegrationRepository.setScopes({
    integrationId: tokenId,
    scopes: ordered as string[],
  })
  if (!result.ok) {
    return {
      status: "error",
      message: "Token not found or DB unreachable.",
      tokenId,
    }
  }

  revalidatePath("/internal/api-scopes")
  return {
    status: "success",
    message: `Saved (${ordered.length} scope${ordered.length === 1 ? "" : "s"}).`,
    tokenId,
  }
}
