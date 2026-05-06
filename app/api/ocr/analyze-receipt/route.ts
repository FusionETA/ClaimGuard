import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"

import { analyzeReceipt } from "@/lib/ai"
import type { CandidateAccount } from "@/lib/ai"
import { getCurrentSession } from "@/lib/auth/session"
import { isKnownCurrency } from "@/lib/currencies"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Confidence threshold for using the AI's suggested chart-of-account.
 * Below this we leave the field blank — better to ask the user than to
 * pre-fill the wrong account and have them not notice.
 *
 * Source of truth for the cutoff is here, not in the LLM prompt: the
 * model returns a number 0..1 and the route decides what to do with it.
 */
const ACCOUNT_SUGGESTION_THRESHOLD = 0.8

const requestSchema = z.object({
  /** Raw OCR text from Tesseract.js (or any other OCR engine).
   *  Capped to 12000 chars to avoid runaway prompt costs on garbage
   *  input. Real receipts are well under 1000. */
  text: z.string().min(1, "OCR text is empty.").max(12_000, "OCR text too large."),
})

/**
 * POST /api/ocr/analyze-receipt
 *
 * Auth: any logged-in user (typically the employee filing a claim).
 *
 * Flow:
 *   1. Validate body (raw OCR text only — the candidate-account list is
 *      pulled server-side so the client can't poison it).
 *   2. Look up the employee's selectable expense accounts so the AI can
 *      suggest one.
 *   3. Call the configured AI provider (Groq by default, Gemini via
 *      AI_PROVIDER env). Provider-level errors propagate as 502.
 *   4. Apply the confidence gate: drop low-confidence COA suggestions.
 *   5. Resolve currency: if the AI's detected code isn't in the org's
 *      allowedCurrencies, fall back to org.defaultCurrency. Empty list
 *      means "any" (we still hand back the AI's read).
 */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }
  if (!session.organizationId) {
    return NextResponse.json(
      { error: "No organization context for this session." },
      { status: 400 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    )
  }

  // Pull the same selectable expense accounts the form will show, so
  // the AI's suggestion is always a valid pick from the user's view.
  // For OCR we don't know the employee's xeroConnection here without
  // an extra lookup; pulling org-wide selectable accounts is cheap and
  // good enough for a suggestion (the form will still constrain the
  // final pick).
  const accounts = await organizationRepository.getChartAccountsForOrganization(
    session.organizationId,
  )
  const candidateAccounts: CandidateAccount[] = accounts
    .filter((a) => a.isSelectable && !a.isDisabled && !a.isBankAccount)
    .map((a) => ({
      id: a.id,
      name: a.name,
      hint: a.type ?? undefined,
    }))

  // Org currency policy — used to constrain / fall-back the AI's read.
  const organization = await organizationRepository.getOrganizationById(
    session.organizationId,
  )
  const allowedCurrencies = organization?.allowedCurrencies ?? []
  const defaultCurrency = organization?.defaultCurrency

  // Server-side observability: log a truncated copy of the OCR text and
  // the parsed extraction so you can debug why fields aren't filling. The
  // OCR is the most common culprit (stylized fonts, low resolution); seeing
  // the raw text quickly tells you whether Tesseract or the LLM is at fault.
  const ocrPreview = parsed.data.text.slice(0, 600)
  console.log(
    "[ocr/analyze-receipt] OCR text (first 600 chars):\n" + ocrPreview,
  )

  let extraction
  try {
    extraction = await analyzeReceipt({
      text: parsed.data.text,
      candidateAccounts,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "AI provider request failed."
    console.error("[ocr/analyze-receipt] Provider error:", message)
    // 502 because the upstream LLM (or a misconfigured key) is the cause.
    return NextResponse.json({ error: message }, { status: 502 })
  }

  console.log("[ocr/analyze-receipt] AI extraction:", {
    provider: extraction.provider,
    supplier: extraction.supplier,
    total: extraction.total,
    date: extraction.date,
    currency: extraction.currency,
    description: extraction.description,
    suggestedAccountConfidence: extraction.suggestedAccountConfidence,
  })

  // Apply COA confidence gate. The AI is told to only pick from the
  // candidate list, but defensively re-verify the id exists.
  const validAccountIds = new Set(candidateAccounts.map((a) => a.id))
  const passedThreshold =
    extraction.suggestedAccountConfidence >= ACCOUNT_SUGGESTION_THRESHOLD
  const accountIdValid =
    extraction.suggestedAccountId !== null &&
    validAccountIds.has(extraction.suggestedAccountId)
  const suggestedAccountId =
    passedThreshold && accountIdValid ? extraction.suggestedAccountId : null

  // Currency normalisation. If AI didn't detect anything, fall back to
  // the org's default. If AI detected a currency that isn't in the org's
  // allowed list (and the list is non-empty), the form will surface this
  // to the user — return both detected + fallback so the UI can decide.
  const detectedCurrency = extraction.currency
  const currencyAllowed =
    detectedCurrency !== null &&
    isKnownCurrency(detectedCurrency) &&
    (allowedCurrencies.length === 0 || allowedCurrencies.includes(detectedCurrency))

  return NextResponse.json({
    extraction: {
      supplier: extraction.supplier,
      total: extraction.total,
      date: extraction.date,
      description: extraction.description,
      detectedCurrency,
      // The currency the form should *select by default*.
      // - Detected, in allowed list → use it
      // - Detected but disallowed → org default (UI also shows a warning)
      // - Not detected → org default
      resolvedCurrency: currencyAllowed
        ? detectedCurrency
        : (defaultCurrency ?? null),
      currencyWasOverridden: detectedCurrency !== null && !currencyAllowed,
      suggestedAccountId,
      // Surface the raw confidence so the UI can show "AI is unsure"
      // hints if you want, even when we drop the suggestion.
      suggestedAccountConfidence: extraction.suggestedAccountConfidence,
      provider: extraction.provider,
    },
  })
}
