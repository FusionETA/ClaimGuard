import "server-only"

import type { AnalyzeReceiptOptions, ReceiptExtraction } from "@/lib/ai"
import { buildReceiptPrompt, parseReceiptResponse } from "@/lib/ai/prompt"

/**
 * Default Gemini model. 2.5 Flash is the current GA flash model — fast,
 * free-tier friendly, and supported on the v1beta API. (The old
 * gemini-1.5-flash was retired by Google and now 404s.) Override with
 * GEMINI_MODEL env (e.g. gemini-2.5-pro for messy receipts).
 */
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

export async function analyzeReceiptTextWithGemini(
  options: AnalyzeReceiptOptions,
): Promise<ReceiptExtraction> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Add it to your env or set AI_PROVIDER=groq.",
    )
  }

  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL
  const prompt = buildReceiptPrompt({
    ocrText: options.text,
    candidateAccounts: options.candidateAccounts,
  })

  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        // Keep extraction deterministic across retries.
        temperature: 0.1,
        maxOutputTokens: 800,
        // Force JSON output. Gemini honors this on 2.x Flash and Pro.
        responseMimeType: "application/json",
        // Disable "thinking" — on 2.5 models it's on by default and can
        // silently eat the entire maxOutputTokens budget, returning an
        // empty completion. We only want the structured JSON.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    throw new Error(
      `Gemini request failed (${response.status}): ${errorBody.slice(0, 300)}`,
    )
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> }
    }>
  }

  const content = payload.candidates?.[0]?.content?.parts?.[0]?.text
  if (!content) {
    throw new Error("Gemini returned an empty completion.")
  }

  return parseReceiptResponse(content, "gemini")
}
