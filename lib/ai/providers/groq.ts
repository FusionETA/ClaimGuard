import "server-only"

import type { AnalyzeReceiptOptions, ReceiptExtraction } from "@/lib/ai"
import { buildReceiptPrompt, parseReceiptResponse } from "@/lib/ai/prompt"

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"

/**
 * Default Groq model. Llama 3.3 70B Versatile is currently their best
 * structured-output model on the free tier. Override per call with
 * `GROQ_MODEL` env if you want to drop to 8B for speed/cost.
 */
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"

export async function analyzeReceiptTextWithGroq(
  options: AnalyzeReceiptOptions,
): Promise<ReceiptExtraction> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not configured. Add it to your env or set AI_PROVIDER=gemini.",
    )
  }

  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL
  const prompt = buildReceiptPrompt({
    ocrText: options.text,
    candidateAccounts: options.candidateAccounts,
  })

  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // Tell Groq to return JSON. This is honored by Llama 3.x on Groq —
      // they expose OpenAI-compatible response_format. Falls back gracefully
      // if the model ignores it (we still defensively parse).
      response_format: { type: "json_object" },
      // Low temp keeps extraction stable across retries.
      temperature: 0.1,
      // Bumped from 800 → 1500 so the longer prompt + receipt OCR + JSON
      // response (especially with longer descriptions) don't get truncated.
      max_tokens: 1500,
      messages: [
        {
          role: "system",
          content:
            "You are a precise receipt parser. Output is always a single valid JSON object matching the exact shape requested by the user. Never include prose, never include markdown fences.",
        },
        { role: "user", content: prompt },
      ],
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    throw new Error(
      `Groq request failed (${response.status}): ${errorBody.slice(0, 300)}`,
    )
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }

  const content = payload.choices?.[0]?.message?.content
  if (!content) {
    throw new Error("Groq returned an empty completion.")
  }

  return parseReceiptResponse(content, "groq")
}
