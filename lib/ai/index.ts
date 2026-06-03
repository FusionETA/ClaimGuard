import "server-only"

import { analyzeReceiptFileWithGemini } from "@/lib/ai/providers/gemini"

/**
 * Strict shape returned by every provider. Lossy on purpose — the LLM is
 * asked to return null for anything it can't read confidently rather than
 * hallucinating. Confidence is a coarse self-rating (0..1) the model
 * gives us so the UI can decide whether to pre-fill or leave blank.
 */
export type ReceiptExtraction = {
  /** Vendor / merchant printed on the receipt. Null if unreadable. */
  supplier: string | null
  /** ISO 4217 currency code (e.g. "MYR", "USD"). Null if not detected. */
  currency: string | null
  /** Total payable on the receipt, in the detected currency. */
  total: number | null
  /** Date on the receipt as ISO yyyy-mm-dd. Null if unparseable. */
  date: string | null
  /** Short human description (1 sentence) summarising line items / nature
   *  of the spend. */
  description: string | null
  /**
   * If a list of candidate chart-of-account ids was passed in, the model
   * may suggest one. The `confidence` is paired so the UI can require a
   * threshold (we currently treat ≥0.8 as "pre-fill", below as "leave
   * blank for the user").
   */
  suggestedAccountId: string | null
  suggestedAccountConfidence: number
  /** The provider used for this call (returned for logging / debugging). */
  provider: "gemini"
}

export type CandidateAccount = {
  id: string
  name: string
  /** Optional hint shown to the model — e.g. "expense", "meals", etc. */
  hint?: string
}

export type AnalyzeReceiptFileOptions = {
  /** Raw file bytes (image or PDF). */
  fileBytes: Buffer
  /** MIME type — used as Gemini's inlineData.mimeType. Must be one of
   *  Gemini's supported types (image/* or application/pdf). */
  mimeType: string
  /** Subset of chart-of-accounts the user is allowed to pick from. The
   *  model is instructed to ONLY suggest from this list (or null). */
  candidateAccounts?: CandidateAccount[]
}

/**
 * Single entry point for receipt extraction. Uploads the raw file to
 * Gemini's multimodal endpoint, which does OCR + structured-field
 * extraction in one shot — replaces an earlier two-stage flow (client
 * Tesseract → server Gemini text parse) that was unreliable on
 * non-English receipts and thermal-printer fonts.
 */
export async function analyzeReceiptFromFile(
  options: AnalyzeReceiptFileOptions,
): Promise<ReceiptExtraction> {
  if (options.fileBytes.length === 0) {
    throw new Error("Cannot analyze an empty file.")
  }
  return analyzeReceiptFileWithGemini(options)
}
