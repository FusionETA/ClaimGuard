/**
 * Coerce a Prisma `Decimal` (or any value with a sane `toString`) to a JS
 * number. The MariaDB adapter returns Decimal as a wrapper object, never as
 * a plain number, so every call site that wants a number needs this helper.
 *
 * - Returns `fallback` when the value is null/undefined.
 * - Returns `undefined` (when fallback is omitted) for non-finite results,
 *   which mirrors the previous `toOptionalNumber` callers' expectations.
 */
export function toNumber(value: unknown, fallback: number): number
export function toNumber(value: unknown): number | undefined
export function toNumber(value: unknown, fallback?: number): number | undefined {
  if (value == null) return fallback
  const n = typeof value === "number" ? value : Number(value as { toString(): string })
  if (!Number.isFinite(n)) return fallback
  return n
}
