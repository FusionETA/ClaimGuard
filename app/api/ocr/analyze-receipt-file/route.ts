import { NextResponse, type NextRequest } from "next/server"
import { safeErrorMessage } from "@/lib/errors"

import { analyzeReceiptFromFile } from "@/lib/ai"
import type { CandidateAccount } from "@/lib/ai"
import { getCurrentSession } from "@/lib/auth/session"
import { isKnownCurrency } from "@/lib/currencies"
import { rateLimit } from "@/lib/rate-limit"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * Same confidence threshold as the text-based route.
 */
const ACCOUNT_SUGGESTION_THRESHOLD = 0.8

/**
 * Accepted MIME types for the vision pipeline. Mirrors the receipt
 * allowlist in `claim-receipts.service.ts` so the OCR endpoint and the
 * upload endpoint agree on what's allowed. PDFs go through Gemini's
 * inlineData PDF path; images use the same path (we just don't route
 * them here yet — see `analyze-receipt/route.ts` for the Tesseract-text
 * pipeline).
 */
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
])

/** 8 MB — matches the upload caps in `claim-receipts.service.ts`. */
const MAX_FILE_SIZE = 8 * 1024 * 1024

/**
 * POST /api/ocr/analyze-receipt-file (multipart)
 *
 * Auth: any logged-in user. Receives a single file under field name
 * "file" plus the same response shape as /api/ocr/analyze-receipt so
 * the client can branch on file type without parsing two response
 * variants.
 *
 * Flow:
 *   1. Auth + rate-limit (same 20 req/min/user as the text route).
 *   2. Pull selectable expense accounts so Gemini can suggest one.
 *   3. Call Gemini's multimodal endpoint with inlineData.
 *   4. Apply COA confidence gate + currency normalisation.
 *
 * Currently called by the claim-flow client only for PDF uploads —
 * images still use Tesseract → text in the browser. The route doesn't
 * actually care which MIME comes in (any supported type works), so it
 * can also serve as the migration path if we ever drop Tesseract.
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

  const rl = await rateLimit({
    scope: "ocr",
    id: session.userId,
    max: 20,
    windowSec: 60,
  })
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(rl.retryAfterSec) },
      },
    )
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data with a `file` field." },
      { status: 400 },
    )
  }

  const file = formData.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing `file` upload." },
      { status: 400 },
    )
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json(
      {
        error:
          "Unsupported file type. Upload a JPG, PNG, WEBP, HEIC, or PDF receipt.",
      },
      { status: 400 },
    )
  }
  if (file.size <= 0) {
    return NextResponse.json({ error: "File is empty." }, { status: 400 })
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "Receipt file must be 8 MB or smaller." },
      { status: 400 },
    )
  }

  const fileBytes = Buffer.from(await file.arrayBuffer())

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

  const organization = await organizationRepository.getOrganizationById(
    session.organizationId,
  )
  const allowedCurrencies = organization?.allowedCurrencies ?? []
  const defaultCurrency = organization?.defaultCurrency

  console.log(
    `[ocr/analyze-receipt-file] vision call: mime=${file.type} size=${file.size}`,
  )

  let extraction
  try {
    extraction = await analyzeReceiptFromFile({
      fileBytes,
      mimeType: file.type,
      candidateAccounts,
    })
  } catch (error) {
    const message = safeErrorMessage(error, "AI provider request failed.")
    console.error("[ocr/analyze-receipt-file] Provider error:", message)
    return NextResponse.json({ error: message }, { status: 502 })
  }

  console.log("[ocr/analyze-receipt-file] Gemini extraction:", {
    provider: extraction.provider,
    supplier: extraction.supplier,
    total: extraction.total,
    date: extraction.date,
    currency: extraction.currency,
    description: extraction.description,
    suggestedAccountConfidence: extraction.suggestedAccountConfidence,
  })

  const validAccountIds = new Set(candidateAccounts.map((a) => a.id))
  const passedThreshold =
    extraction.suggestedAccountConfidence >= ACCOUNT_SUGGESTION_THRESHOLD
  const accountIdValid =
    extraction.suggestedAccountId !== null &&
    validAccountIds.has(extraction.suggestedAccountId)
  const suggestedAccountId =
    passedThreshold && accountIdValid ? extraction.suggestedAccountId : null

  const detectedCurrency = extraction.currency
  const currencyAllowed =
    detectedCurrency !== null &&
    isKnownCurrency(detectedCurrency) &&
    (allowedCurrencies.length === 0 ||
      allowedCurrencies.includes(detectedCurrency))

  return NextResponse.json({
    extraction: {
      supplier: extraction.supplier,
      total: extraction.total,
      date: extraction.date,
      description: extraction.description,
      detectedCurrency,
      resolvedCurrency: currencyAllowed
        ? detectedCurrency
        : (defaultCurrency ?? null),
      currencyWasOverridden: detectedCurrency !== null && !currencyAllowed,
      suggestedAccountId,
      suggestedAccountConfidence: extraction.suggestedAccountConfidence,
      provider: extraction.provider,
    },
  })
}
