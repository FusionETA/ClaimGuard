import "server-only"

import { randomInt } from "node:crypto"

import { getRedis, key } from "@/lib/redis"

/**
 * Password-reset 6-digit codes, stored in Redis.
 *
 *   key("password-reset", "code", email) -> "123456"      EX 600
 *   key("password-reset", "fails", email) -> "0".."5"     EX 600
 *
 * Single-use: `verifyAndConsume` deletes the code on success. Failures
 * increment a per-email counter; on the 5th wrong attempt we delete the
 * code itself so the attacker can't continue guessing — the user must
 * request a new one. Both keys share the same 10-minute TTL so they
 * vanish together.
 *
 * IP rate limiting happens upstream (forgot-password action). This file
 * is only concerned with the per-email lifecycle.
 */

const CODE_TTL_SECONDS = 600 // 10 min
const MAX_FAILS = 5

function codeKey(email: string): string {
  return key("password-reset", "code", email.toLowerCase())
}
function failsKey(email: string): string {
  return key("password-reset", "fails", email.toLowerCase())
}

/// Generate a fresh 6-digit code and stash it in Redis. Returns the code
/// when stored successfully, or null when Redis isn't configured (caller
/// treats null as "can't send right now"; in production this should be
/// monitored — Redis is required infra).
///
/// Re-requests for the same email OVERWRITE the previous code (we don't
/// want a stale code to keep working after the user asks for a new one).
/// The fail-counter is also reset on every issue.
export async function issuePasswordResetCode(
  email: string,
): Promise<string | null> {
  const redis = getRedis()
  if (!redis) return null
  // crypto.randomInt is unbiased — Math.random is biased on the high end
  // for 6-digit ranges. Padded so "000123" never collapses to "123".
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0")
  await redis.set(codeKey(email), code, "EX", CODE_TTL_SECONDS)
  await redis.del(failsKey(email))
  return code
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: "no-code" | "wrong-code" | "locked-out" }

/// Verify a code and consume it on success. Tracks failed attempts —
/// after MAX_FAILS wrong tries, the code is deleted server-side and the
/// caller is told "locked-out". User must request a new code.
export async function verifyAndConsumePasswordResetCode(
  email: string,
  submittedCode: string,
): Promise<VerifyOutcome> {
  const redis = getRedis()
  if (!redis) return { ok: false, reason: "no-code" }

  const stored = await redis.get(codeKey(email))
  if (!stored) return { ok: false, reason: "no-code" }

  if (stored === submittedCode) {
    // Success — delete both keys so the code can't be reused and the
    // fails counter doesn't linger.
    await redis.del(codeKey(email), failsKey(email))
    return { ok: true }
  }

  // Wrong code — bump the counter (creating the key on first miss with
  // same TTL as the code so they expire together).
  const fails = await redis.incr(failsKey(email))
  if (fails === 1) {
    // First fail — pin the TTL so the counter doesn't outlive the code.
    await redis.expire(failsKey(email), CODE_TTL_SECONDS)
  }
  if (fails >= MAX_FAILS) {
    await redis.del(codeKey(email))
    return { ok: false, reason: "locked-out" }
  }
  return { ok: false, reason: "wrong-code" }
}
