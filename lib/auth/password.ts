import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

const KEY_LENGTH = 64

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex")

  return `${salt}:${hash}`
}

export function verifyPassword(password: string, storedHash: string) {
  const [salt, hash] = storedHash.split(":")

  if (!salt || !hash) {
    return false
  }

  const derivedKey = scryptSync(password, salt, KEY_LENGTH)
  const hashBuffer = Buffer.from(hash, "hex")

  if (hashBuffer.length !== derivedKey.length) {
    return false
  }

  return timingSafeEqual(hashBuffer, derivedKey)
}

/**
 * Convention for the "default password" seeded onto every new
 * employee. Format: `<email><MMDD>` where MMDD comes from the
 * employee's DOB (born 23 Nov → `<email>1123`).
 *
 * Shared by:
 *   - `payroll-import.service.ts` when creating employees from XLSX
 *   - `resetEmployeePasswordToDefault` (admin fallback for when the
 *     employee resigns / forgets and admin needs to view their portal)
 *
 * Requires DOB in ISO `yyyy-mm-dd` form. Returns null if the DOB isn't
 * parseable — callers should block the reset with a "Set DOB first"
 * message rather than seed a broken password.
 */
export function defaultPassword(
  email: string,
  dateOfBirth: string | null | undefined,
): string | null {
  if (!email || !dateOfBirth) return null
  const parts = dateOfBirth.split("-")
  const month = parts[1]
  const day = parts[2]
  if (!month || !day || month.length !== 2 || day.length !== 2) return null
  return `${email}${month}${day}`
}
