import "server-only"
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

/**
 * AES-256-GCM helpers for symmetric encryption of small secrets stored
 * at rest. Used by the saved-portal-credentials feature (KWSP / PERKESO
 * passwords on PayrollPortalCredential), but kept generic so other
 * features can adopt it without rewriting.
 *
 * Key management
 * --------------
 * The 32-byte AES key is derived from `PORTAL_CREDS_KEY` (env var) via
 * SHA-256, so the env value can be any reasonable string — a 32+ byte
 * random string in prod, the dev placeholder below in dev. **Do not
 * commit a real prod key.** Rotate by:
 *   1. Write a one-off script that loads every encrypted row, decrypts
 *      with the OLD key, re-encrypts with the NEW key, writes back.
 *   2. Update the env var.
 *
 * Format
 * ------
 * `encryptSecret(plain)` returns a base64 string laid out as:
 *
 *     iv (12 bytes) || authTag (16 bytes) || ciphertext (variable)
 *
 * The IV is fresh-random per call; the auth tag is the AES-GCM tag.
 * `decryptSecret(stored)` splits the blob, verifies the auth tag, and
 * returns the plaintext UTF-8 string. A tampered or wrong-key blob
 * throws — never silently returns garbage.
 */

const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const ALGORITHM = "aes-256-gcm" as const

/// Derive the 32-byte AES key from the env value. Cached after first
/// call — `process.env` reads aren't expensive but the SHA-256 isn't
/// either, and consistent caching keeps the hot path simple.
let keyCache: Buffer | null = null
function getKey(): Buffer {
  if (keyCache) return keyCache
  const raw = process.env.PORTAL_CREDS_KEY ?? ""
  if (raw.trim().length === 0) {
    // Dev-only fallback so the credentials tab works without forcing
    // every contributor to set an env var. In production this branch
    // SHOULD never run — the deploy MUST set PORTAL_CREDS_KEY.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "PORTAL_CREDS_KEY env var is required in production to encrypt saved portal credentials.",
      )
    }
    keyCache = createHash("sha256")
      .update("altomatehr-dev-portal-creds-fallback")
      .digest()
    return keyCache
  }
  keyCache = createHash("sha256").update(raw, "utf8").digest()
  return keyCache
}

/**
 * Encrypt a UTF-8 string with AES-256-GCM. Returns a base64 blob suitable
 * for direct storage in a `String` column.
 *
 * Empty / null inputs return `null` so callers can pass form values
 * through verbatim without a pre-check.
 */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain == null || plain.length === 0) return null
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64")
}

/**
 * Decrypt a base64 blob produced by `encryptSecret`. Returns the
 * plaintext UTF-8 string. Throws if the auth tag is invalid (tampering,
 * wrong key, or truncated blob).
 *
 * Null/empty input → null, so callers can map row → DTO without a
 * pre-check.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored == null || stored.length === 0) return null
  const blob = Buffer.from(stored, "base64")
  if (blob.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error("Stored ciphertext is too short to decrypt.")
  }
  const key = getKey()
  const iv = blob.subarray(0, IV_BYTES)
  const authTag = blob.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES)
  const ciphertext = blob.subarray(IV_BYTES + AUTH_TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const plain = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
  return plain.toString("utf8")
}
