/**
 * Pure PERKESO (SOCSO / EIS / SKBBK) file-format helpers.
 *
 * Kept OUTSIDE the `server-only` renderer boundary (`shared.ts`) so the
 * formatting rules can be unit-tested without pulling in Prisma. The
 * renderers re-export these via `shared.ts`.
 */

/// Convert an RM amount to whole sen (round half away from zero).
export function toSen(rm: number | null | undefined): number {
  if (rm == null) return 0
  return Math.round(rm * 100)
}

/**
 * Format an RM amount as a PERKESO money field: sen with the two cents
 * digits ALWAYS present, i.e. a minimum of 3 digits
 * ([ringgit][2-digit cents]).
 *
 *   RM0.00   → "000"   (NOT "0" — the ASSIST parser rejects a bare 0)
 *   RM0.50   → "050"
 *   RM29.75  → "2975"
 *   RM104.15 → "10415"
 *
 * A zero contribution (e.g. a foreign worker with no EIS) still has to
 * carry its "00" cents. Space-padding to the column width is done
 * separately by the renderer (padLeft) — this only produces the digits.
 */
export function senDigits(rm: number | null | undefined): string {
  return String(toSen(rm)).padStart(3, "0")
}
