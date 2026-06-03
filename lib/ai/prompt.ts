import "server-only"

import type { CandidateAccount, ReceiptExtraction } from "@/lib/ai"

/**
 * Receipt extraction prompt for Gemini's multimodal endpoint — the
 * model is shown the raw receipt image/PDF via `inlineData`, and reads
 * the document directly.
 *
 * Format requirements:
 *  - Output is *only* a JSON object. No prose, no markdown fences.
 *  - All fields present; use null for unknowns.
 *  - Currency is an ISO 4217 code, uppercase.
 *  - Date is ISO yyyy-mm-dd (the model converts local formats).
 *  - When a candidate account list is supplied, the model can pick at
 *    most one id, and must NOT invent ids outside the list.
 */
export function buildReceiptVisionPrompt(opts: {
  candidateAccounts?: CandidateAccount[]
}): string {
  const accountsBlock = (opts.candidateAccounts ?? []).length
    ? renderCandidateAccountsBlock(opts.candidateAccounts!)
    : "No candidate accounts provided. Set suggestedAccountId to null and suggestedAccountConfidence to 0."

  return [
    "You are a receipt and invoice parser. Read the attached receipt or invoice (image or PDF) and extract the canonical fields. Multi-page PDFs may contain a single invoice spanning pages — read all pages before deciding the totals.",
    "",
    "Return ONLY a single JSON object matching this exact shape (no prose, no markdown fences):",
    "",
    "{",
    '  "supplier": "Merchant or vendor name, or null",',
    '  "currency": "ISO 4217 uppercase (MYR, USD, SGD, EUR, ...) or null if unreadable",',
    '  "total": <final total payable as a number, or null>,',
    '  "date": "yyyy-mm-dd or null",',
    '  "description": "One short sentence summarising the spend, or null",',
    '  "suggestedAccountId": "id from the candidate list, or null",',
    '  "suggestedAccountConfidence": <number between 0 and 1>',
    "}",
    "",
    "FIELD-BY-FIELD GUIDANCE:",
    "",
    "supplier — the BUSINESS NAME, almost always at the top of the document. NEVER a cashier/server/host name, table number, invoice number, or generic word like 'RECEIPT' or 'TAX INVOICE'. If you really can't tell, return null.",
    "",
    "total — the GRAND TOTAL the customer paid. Often labeled 'TOTAL', 'AMOUNT', 'GRAND TOTAL', 'AMOUNT DUE', 'BALANCE DUE'. Pick the LAST/largest monetary value before any tip line; never a subtotal or single line item. Return as a plain number (no currency symbol).",
    "",
    "date — the transaction or invoice date. Convert to ISO yyyy-mm-dd. For ambiguous dd/mm vs mm/dd: if either part is >12, it's the day; otherwise assume dd/mm/yyyy.",
    "",
    "currency — ISO 4217 code. RM → MYR, S$ → SGD, HK$ → HKD, NT$ → TWD, A$ → AUD, NZ$ → NZD, C$ → CAD, € → EUR, £ → GBP, ¥ → JPY (or CNY in China). Bare $ is ambiguous → null.",
    "",
    "description — 8 words or less. Lead with WHAT was bought, e.g. 'Coffee and tea at Coffee Shop', 'Lunch at KFC', 'Office stationery'.",
    "",
    "suggestedAccountId — only set when you are clearly confident the spend matches one of the listed accounts. Otherwise null with confidence 0.",
    "",
    "GENERAL RULES:",
    "- Return null for any field you can't read confidently. Do NOT guess wildly.",
    "- Numbers must be plain JSON numbers (no quotes, no currency symbols).",
    "",
    accountsBlock,
  ].join("\n")
}

function renderCandidateAccountsBlock(accounts: CandidateAccount[]): string {
  const lines = accounts.map((a) => {
    const hint = a.hint ? ` (${a.hint})` : ""
    return `- id="${a.id}" name="${a.name}"${hint}`
  })
  return [
    "Candidate chart-of-accounts (pick at most one matching id, or null):",
    ...lines,
  ].join("\n")
}

/**
 * Defensive parse: providers occasionally wrap JSON in markdown fences
 * or prefix with prose despite instructions. This strips that noise and
 * coerces fields to the canonical shape, applying sensible bounds.
 */
export function parseReceiptResponse(
  raw: string,
  provider: "gemini",
): ReceiptExtraction {
  const stripped = stripCodeFences(raw).trim()

  // The model may return surrounding prose. Slice from the first '{' to
  // the last '}' to be robust.
  const firstBrace = stripped.indexOf("{")
  const lastBrace = stripped.lastIndexOf("}")
  const jsonSlice =
    firstBrace >= 0 && lastBrace > firstBrace
      ? stripped.slice(firstBrace, lastBrace + 1)
      : stripped

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonSlice)
  } catch (error) {
    throw new Error(
      `Provider ${provider} returned non-JSON: ${(error as Error).message}. Raw: ${raw.slice(0, 200)}`,
    )
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Provider ${provider} returned non-object JSON.`)
  }

  const obj = parsed as Record<string, unknown>

  return {
    supplier: stringOrNull(obj.supplier),
    currency: normalizeCurrency(obj.currency),
    total: numberOrNull(obj.total),
    date: stringOrNull(obj.date),
    description: stringOrNull(obj.description),
    suggestedAccountId: stringOrNull(obj.suggestedAccountId),
    suggestedAccountConfidence: clamp01(numberOrNull(obj.suggestedAccountConfidence) ?? 0),
    provider,
  }
}

function stripCodeFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === "null") return null
  return trimmed
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function normalizeCurrency(value: unknown): string | null {
  const s = stringOrNull(value)
  if (!s) return null
  // ISO 4217 codes are 3 uppercase letters. Allow longer strings but
  // pick the first 3-letter token if present.
  const match = s.toUpperCase().match(/[A-Z]{3}/)
  return match ? match[0] : null
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
