import "server-only"

/**
 * Generic multi-turn text chat against Groq's OpenAI-compatible endpoint.
 * Mirrors the inline Groq call in `csv-mapper-ai.ts`, but generalized for
 * chat-style AI-assist features (free-form prose, no forced response
 * format) rather than structured-JSON column mapping. That file's own
 * call is left untouched — this is a separate, reusable sibling.
 */

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"

export type GroqChatMessage = { role: "system" | "user" | "assistant"; content: string }

export async function chatWithGroq(options: {
  messages: GroqChatMessage[]
  temperature?: number
  maxTokens?: number
}): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured.")
  }

  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL

  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: options.messages,
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxTokens ?? 2000,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    throw new Error(`Groq chat request failed (${response.status}): ${errorBody.slice(0, 300)}`)
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }

  const reply = payload.choices?.[0]?.message?.content
  if (!reply) {
    throw new Error("Groq chat returned an empty completion.")
  }

  return reply
}
