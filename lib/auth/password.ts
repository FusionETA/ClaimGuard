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
