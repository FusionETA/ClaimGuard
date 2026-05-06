import "server-only"

import type { AnalyzeReceiptOptions, ReceiptExtraction } from "@/lib/ai"
import { buildReceiptPrompt, parseReceiptResponse } from "@/lib/ai/prompt"

/**
 * Default Gemini model. 1.5 Flash is fast and free-tier friendly; for
 * messy receipts you may want to bump to 1.5 Pro via GEMINI_MODEL env.
 */
const DEFAULT_GEMINI_MODEL = "gemini-1.5-flash"

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
        // Force JSON output. Gemini honors this on 1.5 Flash and Pro.
        responseMimeType: "application/json",
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
