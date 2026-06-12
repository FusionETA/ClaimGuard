import "server-only"

import { isAdminRole } from "@/lib/auth/types"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { decryptSecret, encryptSecret } from "@/lib/crypto"
import {
  portalCredentialRepository,
  type PortalCredentialPatch,
  type PortalKind,
} from "@/modules/payroll/infrastructure/portal-credential.repository"

/**
 * Saved-credentials orchestration for the Payroll Settings →
 * Credentials tab. Handles session/role checks, transforms between the
 * encrypted DB row and the plaintext DTO the UI consumes, and exposes
 * a tiny CRUD surface for the credential set per portal.
 *
 * The plaintext password is intentionally returned to the admin via
 * `getCredentialsForOrg()` — the whole feature is "let me copy-paste my
 * KWSP password into the portal without fishing it out of 1Password".
 * Admin-only role gate at the service boundary keeps this safe (only
 * full admins can see Settings at all).
 */

export type PortalCredentialDto = {
  portal: PortalKind
  userId: string | null
  password: string | null
  image: string | null
  secretCode: string | null
  securityPhrase: string | null
  passwordReminder: string | null
  notes: string | null
  hasPassword: boolean
  updatedAt: string | null
}

export type PortalCredentialInput = {
  portal: PortalKind
  userId?: string | null
  /// Plain-text password. The service encrypts before persisting.
  /// Pass `null` to clear; pass `undefined` to leave the existing
  /// ciphertext untouched (e.g. user updated other fields only).
  password?: string | null
  image?: string | null
  secretCode?: string | null
  securityPhrase?: string | null
  passwordReminder?: string | null
  notes?: string | null
}

/**
 * Load all saved credentials for the active org. Returns an array
 * sorted by portal name so the UI can render the cards in a stable
 * order. Decrypts each password client-side-of-the-DB but server-side-
 * of-the-network — the plaintext only leaves this service via React's
 * server-component render or an explicit server action.
 */
export async function getPortalCredentialsForActiveOrg(): Promise<
  PortalCredentialDto[]
> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) return []
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return []

  const rows = await portalCredentialRepository.listByOrgId(orgId)
  return rows.map(toDto)
}

/**
 * Upsert one portal's credentials. Encrypts the password before write
 * when the caller supplied one; leaves it untouched when the field is
 * undefined.
 */
export async function upsertPortalCredential(
  input: PortalCredentialInput,
): Promise<PortalCredentialDto> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")

  const patch: PortalCredentialPatch = {
    userId: input.userId ?? null,
    image: input.image ?? null,
    secretCode: input.secretCode ?? null,
    securityPhrase: input.securityPhrase ?? null,
    passwordReminder: input.passwordReminder ?? null,
    notes: input.notes ?? null,
  }

  // Only touch the ciphertext when the caller actually passed a value
  // (including an explicit null = clear). `undefined` means "leave it
  // alone" so partial updates don't blow away the saved password.
  if (input.password !== undefined) {
    patch.passwordEnc =
      input.password === null || input.password === ""
        ? null
        : encryptSecret(input.password)
  }

  const row = await portalCredentialRepository.upsert({
    organizationId: orgId,
    portal: input.portal,
    patch,
  })
  return toDto(row)
}

export async function deletePortalCredential(portal: PortalKind): Promise<void> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    throw new Error("Session expired. Please log in again.")
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) throw new Error("No active organisation.")
  await portalCredentialRepository.delete({
    organizationId: orgId,
    portal,
  })
}

function toDto(row: Awaited<ReturnType<typeof portalCredentialRepository.getOne>>): PortalCredentialDto {
  if (!row) {
    // Shouldn't be reachable because callers pass existing rows, but
    // keeps the return type honest.
    throw new Error("Internal: toDto called with null row")
  }
  // Decrypt failure shouldn't bring the page down — surface as null so
  // the admin sees "no password saved" and can re-enter, rather than a
  // 500. We still log the cause so operators can investigate.
  let plain: string | null = null
  if (row.passwordEnc) {
    try {
      plain = decryptSecret(row.passwordEnc)
    } catch (err) {
      console.error(
        `[portal-credential] decrypt failed for org=${row.organizationId} portal=${row.portal}:`,
        err,
      )
      plain = null
    }
  }
  return {
    portal: row.portal,
    userId: row.userId,
    password: plain,
    image: row.image,
    secretCode: row.secretCode,
    securityPhrase: row.securityPhrase,
    passwordReminder: row.passwordReminder,
    notes: row.notes,
    hasPassword: Boolean(row.passwordEnc),
    updatedAt: row.updatedAt,
  }
}
