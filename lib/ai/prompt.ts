import "server-only"

import type { CandidateAccount, ReceiptExtraction } from "@/lib/ai"

/**
 * Builds the prompt used by every provider. Kept in its own module so
 * the prompt can evolve independently from the provider plumbing and
 * stays source-of-truth for the shape we expect the model to return.
 *
 * Format requirements:
 *  - Output is *only* a JSON object. No prose, no markdown fences.
 *  - All fields present; use null for unknowns.
 *  - Currency is an ISO 4217 code, uppercase.
 *  - Date is ISO yyyy-mm-dd (the model is told to convert local formats).
 *  - When a candidate account list is supplied, the model can pick at
 *    most one id, and must NOT invent ids outside the list.
 */
export function buildReceiptPrompt(opts: {
  ocrText: string
  candidateAccounts?: CandidateAccount[]
}): string {
  const accountsBlock = (opts.candidateAccounts ?? []).length
    ? renderCandidateAccountsBlock(opts.candidateAccounts!)
    : "No candidate accounts provided. Set suggestedAccountId to null and suggestedAccountConfidence to 0."

  return [
    "You are a receipt and invoice parser. The user pasted the raw OCR text of a printed receipt. OCR is often noisy — characters can be misread (0/O, 1/I/l, 5/S), spaces can be missing or extra, and lines can be in unexpected order. Your job is to be a smart human reading the messy text and extracting the canonical fields.",
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
    "supplier — the BUSINESS NAME, almost always at the very top of the receipt in larger or bolder text. Examples: 'STARBUCKS', 'COFFEE SHOP', 'KFC', 'SHELL'. It is NEVER:",
    "  • a host/cashier/server/staff name (e.g. 'HOST: AMY', 'CASHIER: JOHN', 'SERVER 12')",
    "  • a table or order number ('TABLE 3', 'ORDER #1029')",
    "  • a tax invoice or receipt number ('INV-1029', 'TAX INVOICE: 12345')",
    "  • a generic word like 'RECEIPT', 'INVOICE', 'BILL', or 'TAX INVOICE'",
    "  If the only text near the top is one of those, scan the rest of the OCR for the business name. If you really can't tell, return null — do NOT use a host/table/invoice number as the supplier.",
    "",
    "total — the GRAND TOTAL the customer paid. Lines often labeled 'TOTAL', 'AMOUNT', 'GRAND TOTAL', 'AMOUNT DUE', 'BALANCE DUE', 'NET TOTAL'. Pick the LAST/largest monetary value before any tip line, NOT subtotal, NOT individual line items, NOT tax. If multiple candidates, prefer the one labeled with 'TOTAL' or 'AMOUNT'. Return as a plain number (no currency symbol), e.g. 17 or 17.00.",
    "",
    "date — the transaction date. Common formats: dd/mm/yyyy, mm/dd/yyyy, yyyy-mm-dd, '07 SEP 2025', 'Sept 7, 2025'. Convert to ISO yyyy-mm-dd. For ambiguous dd/mm vs mm/dd: if either part is >12, it's the day; otherwise assume dd/mm/yyyy (international default).",
    "",
    "currency — ISO 4217 code. RM → MYR, S$ → SGD, HK$ → HKD, NT$ → TWD, A$ → AUD, NZ$ → NZD, C$ → CAD, € → EUR, £ → GBP, ¥ → JPY (or CNY in China). Bare $ is ambiguous → null.",
    "",
    "description — 8 words or less. Lead with WHAT was bought, e.g. 'Coffee and tea at Coffee Shop', 'Lunch at KFC', 'Office stationery', 'Taxi fare'. Use the supplier name if known.",
    "",
    "suggestedAccountId — only set when you are clearly confident the spend matches one of the listed accounts (e.g. coffee receipt → Meals & Entertainment). Otherwise null with confidence 0.",
    "",
    "EXAMPLE 1 (clean receipt):",
    "OCR text:",
    "  STARBUCKS COFFEE",
    "  KLCC, Kuala Lumpur",
    "  RECEIPT #4892",
    "  15/03/2025  14:22",
    "  Cashier: SARAH",
    "  Latte (Tall)         RM 12.00",
    "  Croissant            RM  8.50",
    "  Subtotal             RM 20.50",
    "  SST 6%               RM  1.23",
    "  TOTAL                RM 21.73",
    "Output:",
    '  {"supplier":"STARBUCKS COFFEE","currency":"MYR","total":21.73,"date":"2025-03-15","description":"Coffee and croissant at Starbucks","suggestedAccountId":null,"suggestedAccountConfidence":0}',
    "",
    "EXAMPLE 2 (noisy OCR — supplier name partly misread, host name clearer):",
    "OCR text:",
    "  C0FFEE SH0P",
    "  Address: Street Location",
    "  Tel. 777777",
    "  07/09/2025   09:30:17 AM",
    "  TABLE 3   HOST: AMY",
    "  TAX INVOICE: 112375004",
    "  CAPPUCCINO    $4.50",
    "  HOT CHOCOLATE $6.40",
    "  ICED TEA      $4.50",
    "  SUBTOTAL    $15.60",
    "  SALE TAX    $ 1.40",
    "  AMOUNT      $17.00",
    "Output:",
    '  {"supplier":"COFFEE SHOP","currency":null,"total":17,"date":"2025-09-07","description":"Coffee, hot chocolate, and iced tea at Coffee Shop","suggestedAccountId":null,"suggestedAccountConfidence":0}',
    "(Note: supplier was \"C0FFEE SH0P\" with zeros in OCR — corrected to \"COFFEE SHOP\". Currency is bare $ → null. \"AMY\" was a host, not the supplier.)",
    "",
    "GENERAL RULES:",
    "- Return null for any field you can't read with reasonable confidence. Do NOT guess wildly.",
    "- BUT do gently correct obvious OCR errors in supplier/description (0→O, 1→I, 5→S where context makes it clear).",
    "- Numbers must be plain JSON numbers (no quotes, no currency symbols).",
    "",
    accountsBlock,
    "",
    "OCR text:",
    "---",
    opts.ocrText,
    "---",
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
  provider: "groq" | "gemini",
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
