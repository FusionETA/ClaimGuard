import "server-only"

import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { rateLimit } from "@/lib/rate-limit"
import { chatWithGroq } from "@/lib/ai/providers/groq"
import { chatWithGemini } from "@/lib/ai/providers/gemini"
import {
  parseAiQuestionBlocks,
  parseAiTemplateBlocks,
  type AiChatMessage,
  type AiGeneratedTemplate,
  type AiSuggestedQuestion,
} from "@/modules/appraisify/domain/models"

/* ── Zod ───────────────────────────────────────────────────────────── */

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4000),
})

export const aiAssistChatSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(60),
  templateName: z.string().max(120).nullable(),
  existingSections: z.array(z.string().max(120)).max(50),
})
export type AiAssistChatInput = z.infer<typeof aiAssistChatSchema>

// The seed message (the question being improved, phrased as a user turn) is
// built client-side and sent as the first entry in `messages` — the server
// doesn't need the original question separately, just the conversation.
export const aiImproveQuestionSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(60),
})
export type AiImproveQuestionInput = z.infer<typeof aiImproveQuestionSchema>

export const aiSetupChatSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(80),
  templatesGenerated: z.number().int().min(0).max(5),
})
export type AiSetupChatInput = z.infer<typeof aiSetupChatSchema>

/* ── Result shapes ────────────────────────────────────────────────── */

type AiChatResult =
  | { ok: true; replyText: string; questions: AiSuggestedQuestion[] }
  | { ok: false; message: string }

type AiSetupChatResult =
  | { ok: true; replyText: string; templates: AiGeneratedTemplate[] }
  | { ok: false; message: string }

const TEMPLATE_SETUP_LIMIT = 5

/* ── Provider fan-out: Groq primary, Gemini fallback ─────────────────
 * Mirrors aiMapCsvColumns's tier order (Groq → Gemini). Groq's wire
 * format is OpenAI-style (system/user/assistant roles map 1:1); Gemini
 * wants "model" instead of "assistant" and takes the system prompt via
 * a separate `system_instruction` field rather than as a message.
 */
async function completeChat(systemPrompt: string, messages: AiChatMessage[]): Promise<string> {
  try {
    return await chatWithGroq({
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      temperature: 0.4,
      maxTokens: 2000,
    })
  } catch (groqErr) {
    try {
      return await chatWithGemini({
        systemInstruction: systemPrompt,
        messages: messages.map((m) => ({
          role: m.role === "assistant" ? ("model" as const) : ("user" as const),
          text: m.content,
        })),
        temperature: 0.4,
        maxOutputTokens: 2000,
      })
    } catch (geminiErr) {
      throw new Error(
        `AI chat unavailable (Groq: ${groqErr instanceof Error ? groqErr.message : "?"}; Gemini: ${
          geminiErr instanceof Error ? geminiErr.message : "?"
        })`,
      )
    }
  }
}

/* ── System prompts ──────────────────────────────────────────────────
 * Authored directly against our flat template schema — a template is
 * just {name, questions:[{section,text,description}]} with freeform
 * section strings, no type/team/role, no scope-vs-engagement split. The
 * model is never asked to produce (and the parser never expects) the
 * richer nested shape some reference apps use.
 */

function buildAiAssistSystemPrompt(ctx: { templateName: string | null; existingSections: string[] }): string {
  return `You are an expert HR specialist helping design performance-appraisal questions.

Current draft: template name is ${ctx.templateName || "not yet named"}. Existing sections already used in this draft: ${
    ctx.existingSections.length ? ctx.existingSections.join(", ") : "none yet"
  }.

Respond conversationally and concisely. When you have concrete question suggestions, wrap them in a tag block like this:
<questions>[{"section":"Section Name","text":"The question text?","desc":"Optional scoring guidance for the reviewer"}]</questions>

Guidelines:
- You may reuse one of the existing sections above, or propose a new one if it fits better — sections are a plain label here, not a fixed taxonomy.
- Group questions into logical sections (3-5 questions per section is ideal).
- Questions must be clear, specific, and scoreable on a 1-5 scale.
- The "desc" field should help reviewers understand how to score fairly.
- Ask clarifying questions when the request is vague, instead of guessing.
- Suggest 6-12 questions total unless the user asks for a specific number.
- When asked to refine or improve, output a brand new complete <questions> block rather than describing the change in prose.`
}

function buildAiImproveSystemPrompt(): string {
  return `You are an expert HR specialist helping improve a single performance-appraisal question.

Respond conversationally and concisely. Wrap your improved suggestion in a tag block containing exactly one item:
<questions>[{"section":"Section Name","text":"The improved question text?","desc":"Optional scoring guidance for the reviewer"}]</questions>

Keep the same general topic unless asked to change it. The "desc" field should help reviewers understand how to score fairly.`
}

function buildAiSetupSystemPrompt(templatesGenerated: number): string {
  const remaining = Math.max(0, TEMPLATE_SETUP_LIMIT - templatesGenerated)
  return `You are an AI HR consultant helping a company set up a suite of performance-appraisal templates.

TEMPLATE LIMIT: You may generate at most ${TEMPLATE_SETUP_LIMIT} templates per session. So far ${templatesGenerated} template(s) have been generated. You have ${remaining} template(s) remaining. If remaining is 0, do not output any <template> blocks — tell the user the session limit has been reached and they should save their templates or start a new session. Never propose more templates than the remaining slots allow.

Work in three phases:

PHASE 1 - Gather information (ask 2-3 questions at a time, not all at once):
- Company industry / sector
- Company size and structure (approximate headcount, main departments)
- Role levels / seniority bands used (e.g. Junior, Mid, Senior, Manager, Director, or custom levels)
- Types of reviews needed (Annual, Probation, Mid-Year, PIP, 360, etc.)
- Any specific performance focus areas or company values
Don't generate templates until you have enough information to make them specific and relevant. Aim for at least 3-4 exchanges before generating.

PHASE 2 - Propose a plan:
Once you have enough context, briefly list the template names you'll create (max ${remaining} more) and ask for confirmation or adjustments before generating.

PHASE 3 - Generate templates:
Output each complete template wrapped in <template> tags as a single JSON object, one per block:
<template>{"name":"Annual Review - Engineering - Senior","questions":[{"section":"Code Quality","text":"How consistently does this employee write clean, well-documented code?","desc":"1 = frequent issues, 5 = consistently excellent"},{"section":"Code Quality","text":"How effectively does this employee handle code reviews?","desc":"1 = rarely reviews, 5 = thorough and constructive"},{"section":"Technical Leadership","text":"How effectively does this employee mentor junior team members?","desc":"1 = no mentoring, 5 = actively develops others"},{"section":"Employee Engagement","text":"How satisfied are you with the support you receive from your manager?","desc":"1 = very unsatisfied, 5 = very satisfied"}]}</template>

Rules:
- One flat "questions" array per template — do not nest scope/engagement or any other sub-structure.
- Each template needs 6-16 questions across 2-4 sections. Section labels are freeform (e.g. "Technical Skills", "Collaboration", "Employee Engagement") — use whatever fits the template.
- Questions must be specific to the company context gathered in Phase 1, not generic.
- The "desc" field explains how to score on a 1-5 scale.
- Generate all confirmed templates in one message, one after another.`
}

/* ── Entry points ─────────────────────────────────────────────────── */

async function requireSessionAndOrg(): Promise<{ userId: string; orgId: string } | null> {
  const session = await getCurrentSession()
  if (!session) return null
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return null
  return { userId: session.userId, orgId }
}

/** In-builder AI chat: drafts/suggests questions for the template being edited. */
export async function aiAssistChat(input: unknown): Promise<AiChatResult> {
  const auth = await requireSessionAndOrg()
  if (!auth) return { ok: false, message: "Not signed in." }

  const rl = await rateLimit({ scope: "appraisify-ai-assist", id: auth.userId, max: 20, windowSec: 60 })
  if (!rl.ok) return { ok: false, message: "Too many AI requests. Try again in a moment." }

  const parsed = aiAssistChatSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: "Invalid request." }
  const { messages, templateName, existingSections } = parsed.data

  try {
    const systemPrompt = buildAiAssistSystemPrompt({ templateName, existingSections })
    const raw = await completeChat(systemPrompt, messages)
    const { questions, cleanedText } = parseAiQuestionBlocks(raw)
    return { ok: true, replyText: cleanedText, questions }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "AI request failed." }
  }
}

/** Per-question "Improve with AI" — same tag contract, seeded with a single question. */
export async function aiImproveQuestion(input: unknown): Promise<AiChatResult> {
  const auth = await requireSessionAndOrg()
  if (!auth) return { ok: false, message: "Not signed in." }

  const rl = await rateLimit({ scope: "appraisify-ai-assist", id: auth.userId, max: 20, windowSec: 60 })
  if (!rl.ok) return { ok: false, message: "Too many AI requests. Try again in a moment." }

  const parsed = aiImproveQuestionSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: "Invalid request." }
  const { messages } = parsed.data

  try {
    const systemPrompt = buildAiImproveSystemPrompt()
    const raw = await completeChat(systemPrompt, messages)
    const { questions, cleanedText } = parseAiQuestionBlocks(raw)
    return { ok: true, replyText: cleanedText, questions }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "AI request failed." }
  }
}

/** Bulk onboarding wizard: generates up to 5 full templates in a session. */
export async function aiSetupChat(input: unknown): Promise<AiSetupChatResult> {
  const auth = await requireSessionAndOrg()
  if (!auth) return { ok: false, message: "Not signed in." }

  const rl = await rateLimit({ scope: "appraisify-ai-setup", id: auth.userId, max: 20, windowSec: 60 })
  if (!rl.ok) return { ok: false, message: "Too many AI requests. Try again in a moment." }

  const parsed = aiSetupChatSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: "Invalid request." }
  const { messages, templatesGenerated } = parsed.data

  try {
    const systemPrompt = buildAiSetupSystemPrompt(templatesGenerated)
    const raw = await completeChat(systemPrompt, messages)
    const { templates, cleanedText } = parseAiTemplateBlocks(raw)

    // Never trust the model to have honored the cap on its own.
    const remaining = Math.max(0, TEMPLATE_SETUP_LIMIT - templatesGenerated)
    const capped = templates.slice(0, remaining)

    return { ok: true, replyText: cleanedText, templates: capped }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "AI request failed." }
  }
}
