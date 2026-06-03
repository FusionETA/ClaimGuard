import "server-only"

import {
  analyzeReceiptFileWithGemini,
  analyzeReceiptTextWithGemini,
} from "@/lib/ai/providers/gemini"
import { analyzeReceiptTextWithGroq } from "@/lib/ai/providers/groq"

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
  provider: "groq" | "gemini"
}

export type CandidateAccount = {
  id: string
  name: string
  /** Optional hint shown to the model — e.g. "expense", "meals", etc. */
  hint?: string
}

export type AnalyzeReceiptOptions = {
  /** Plain OCR text from Tesseract or any other OCR engine. */
  text: string
  /** Subset of chart-of-accounts the user is allowed to pick from. The
   *  model is instructed to ONLY suggest from this list (or null). */
  candidateAccounts?: CandidateAccount[]
  /** Force a provider override. Otherwise uses AI_PROVIDER env (default
   *  "gemini"). */
  provider?: "groq" | "gemini"
}

export type AnalyzeReceiptFileOptions = {
  /** Raw file bytes (image or PDF). */
  fileBytes: Buffer
  /** MIME type — used as Gemini's inlineData.mimeType. Must be one of
   *  Gemini's supported types (image/* or application/pdf). */
  mimeType: string
  /** Subset of chart-of-accounts the user is allowed to pick from. */
  candidateAccounts?: CandidateAccount[]
}

/**
 * Single entry-point used by API routes. Picks a provider and dispatches.
 * Provider selection precedence: explicit `options.provider` arg → env
 * `AI_PROVIDER` → "gemini".
 *
 * Throws on:
 *  - missing API key for the chosen provider
 *  - LLM returning unparseable / non-JSON output (after retries handled
 *    inside the provider impl)
 *
 * Does NOT throw on:
 *  - low-confidence extractions; the caller decides what to pre-fill.
 */
export async function analyzeReceipt(
  options: AnalyzeReceiptOptions,
): Promise<ReceiptExtraction> {
  const provider = options.provider ?? resolveProviderFromEnv()

  if (!options.text || options.text.trim().length === 0) {
    throw new Error("Cannot analyze an empty OCR text payload.")
  }

  switch (provider) {
    case "groq":
      return analyzeReceiptTextWithGroq(options)
    case "gemini":
      return analyzeReceiptTextWithGemini(options)
    default: {
      const _exhaustive: never = provider
      void _exhaustive
      throw new Error(`Unknown AI provider: ${provider as string}`)
    }
  }
}

/**
 * Vision variant — used when the client uploads the raw receipt (PDF or
 * image) instead of running Tesseract first. Always dispatches to Gemini:
 * Groq's chat completion API doesn't accept inline image/PDF data in this
 * codebase. Throws if `GEMINI_API_KEY` is missing.
 */
export async function analyzeReceiptFromFile(
  options: AnalyzeReceiptFileOptions,
): Promise<ReceiptExtraction> {
  if (options.fileBytes.length === 0) {
    throw new Error("Cannot analyze an empty file.")
  }
  return analyzeReceiptFileWithGemini(options)
}

function resolveProviderFromEnv(): "groq" | "gemini" {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase()
  if (raw === "groq") return "groq"
  // Default to Gemini for receipt OCR — better at reading messy receipt
  // OCR text. Set AI_PROVIDER=groq to switch back.
  return "gemini"
}
