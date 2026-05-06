/**
 * Curated list of ISO 4217 currency codes the admin can pick from in
 * Organization settings. Kept short on purpose — these cover ~99% of
 * actual expense submissions in this region. Add more here if a customer
 * needs an exotic one (the column is just a JSON array of codes, no
 * schema change required).
 *
 * `symbol` is for display only; the claim form shows "MYR (RM)" etc. so
 * employees aren't guessing.
 */
export type CurrencyOption = {
  code: string
  name: string
  symbol: string
}

export const CURRENCY_CATALOG: CurrencyOption[] = [
  { code: "MYR", name: "Malaysian Ringgit", symbol: "RM" },
  { code: "SGD", name: "Singapore Dollar", symbol: "S$" },
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "GBP", name: "British Pound", symbol: "£" },
  { code: "JPY", name: "Japanese Yen", symbol: "¥" },
  { code: "CNY", name: "Chinese Yuan", symbol: "¥" },
  { code: "HKD", name: "Hong Kong Dollar", symbol: "HK$" },
  { code: "TWD", name: "Taiwan Dollar", symbol: "NT$" },
  { code: "KRW", name: "South Korean Won", symbol: "₩" },
  { code: "AUD", name: "Australian Dollar", symbol: "A$" },
  { code: "NZD", name: "New Zealand Dollar", symbol: "NZ$" },
  { code: "CAD", name: "Canadian Dollar", symbol: "C$" },
  { code: "CHF", name: "Swiss Franc", symbol: "Fr" },
  { code: "INR", name: "Indian Rupee", symbol: "₹" },
  { code: "IDR", name: "Indonesian Rupiah", symbol: "Rp" },
  { code: "THB", name: "Thai Baht", symbol: "฿" },
  { code: "VND", name: "Vietnamese Dong", symbol: "₫" },
  { code: "PHP", name: "Philippine Peso", symbol: "₱" },
  { code: "BND", name: "Brunei Dollar", symbol: "B$" },
  { code: "AED", name: "UAE Dirham", symbol: "د.إ" },
  { code: "SAR", name: "Saudi Riyal", symbol: "﷼" },
  { code: "ZAR", name: "South African Rand", symbol: "R" },
  { code: "MXN", name: "Mexican Peso", symbol: "$" },
  { code: "BRL", name: "Brazilian Real", symbol: "R$" },
]

const CATALOG_BY_CODE = new Map(CURRENCY_CATALOG.map((c) => [c.code, c]))

/** True iff `code` is in the curated list. Reject unknowns at the form
 *  layer so we don't end up with garbage strings in the DB. */
export function isKnownCurrency(code: string): boolean {
  return CATALOG_BY_CODE.has(code.toUpperCase())
}

/** Look up a single option, e.g. for rendering "MYR (RM)" in the UI. */
export function getCurrencyOption(code: string): CurrencyOption | null {
  return CATALOG_BY_CODE.get(code.toUpperCase()) ?? null
}

/**
 * Sanitize a JSON column value into a clean string array. The DB column
 * is `Json?` so anything could be in there from a botched migration —
 * coerce safely.
 */
export function parseAllowedCurrencies(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== "string") continue
    const code = v.toUpperCase()
    if (!isKnownCurrency(code)) continue
    if (seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out
}

/**
 * Final fallback used when the org hasn't set a default yet. "MYR"
 * matches our primary market; if you need a different default per
 * deployment, change this constant.
 */
export const SYSTEM_FALLBACK_CURRENCY = "MYR"
