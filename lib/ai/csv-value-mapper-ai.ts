import "server-only"

/**
 * Server-only half of the CSV value mapper.
 *
 * Sister file to `./csv-mapper-ai.ts`. Where the column mapper decides
 * which CSV column maps to which schema field, this file decides how
 * each distinct cell value in an enum/boolean column maps to one of
 * our canonical enum values (e.g. "Employed" → `TRUE`,
 * "Married w/ kids" → `MARRIED`).
 *
 * Public surface: `aiMapCsvValues(input)`. Three-tier chain:
 *
 *   1. GROQ          (primary)
 *   2. Gemini        (backup)
 *   3. Heuristic     (no-network synonym match — always returns)
 */

import {
  CATEGORICAL_TARGETS,
  heuristicMatchCategorical,
  type CategoricalTargetSpec,
  type ValueMappingResult,
  type ValueMappingSuggestion,
} from "./csv-value-mapper"
import type { MappingConfidence } from "./csv-mapper"

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
// gemini-2.5-flash is the current GA flash model. The old
// gemini-1.5-flash was retired by Google and now 404s — which is why
// the Groq→Gemini fallback used to error out. Override via GEMINI_MODEL.
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"

/**
 * Defensive cap on how many distinct raw values we ask the AI to map
 * per column. A column accidentally mapped to an enum target could
 * have thousands of distinct values; we don't want to fire that into
 * the model. The wizard surfaces a warning when this cap kicks in so
 * the admin can revisit the column mapping.
 */
const MAX_DISTINCT_VALUES_PER_COLUMN = 50

export type ValueMapperInputColumn = {
  /** Target schema field key, e.g. "maritalStatus", "contributeToEpf". */
  target: string
  /** Source CSV column header — surfaced in the prompt for context. */
  sourceColumn: string
  /** Distinct raw values seen in this column (verbatim, post-trim). */
  rawValues: string[]
}

export type ValueMapperInput = {
  columns: ValueMapperInputColumn[]
}

/**
 * Three-tier value mapper. Always returns — heuristic mode requires
 * no network. `method` tells the caller which tier produced the
 * result so the UI can label it accordingly.
 */
export async function aiMapCsvValues(
  input: ValueMapperInput,
): Promise<ValueMappingResult> {
  // Trim, de-dupe, and cap each column's raw values once up-front so
  // every tier sees the same input.
  const tooMany: string[] = []
  const sanitized: ValueMapperInputColumn[] = input.columns.map((c) => {
    const distinct = Array.from(
      new Set(c.rawValues.map((v) => (v ?? "").trim()).filter((v) => v !== "")),
    )
    if (distinct.length > MAX_DISTINCT_VALUES_PER_COLUMN) {
      tooMany.push(
        `Column "${c.sourceColumn}" mapped to ${c.target} has ${distinct.length} distinct values — only the first ${MAX_DISTINCT_VALUES_PER_COLUMN} will be auto-mapped. Did you mean to map this column to an enum?`,
      )
    }
    return {
      target: c.target,
      sourceColumn: c.sourceColumn,
      rawValues: distinct.slice(0, MAX_DISTINCT_VALUES_PER_COLUMN),
    }
  })

  // Only ask the AI about columns whose target is actually categorical.
  // Non-categorical targets (free text, numbers, dates) are dropped —
  // they shouldn't have been included by the caller, but defend.
  const filtered = sanitized.filter((c) => c.target in CATEGORICAL_TARGETS)
  if (filtered.length === 0) {
    return {
      suggestions: {},
      warnings: tooMany,
      method: "heuristic",
    }
  }

  // Tier 1 — GROQ.
  try {
    const groq = await aiMapCsvValuesWithGroq(filtered)
    return {
      suggestions: groq.suggestions,
      warnings: [...tooMany, ...groq.warnings],
      method: "groq",
    }
  } catch (groqErr) {
    // Tier 2 — Gemini.
    try {
      const gemini = await aiMapCsvValuesWithGemini(filtered)
      return {
        suggestions: gemini.suggestions,
        warnings: [...tooMany, ...gemini.warnings],
        method: "gemini",
      }
    } catch (geminiErr) {
      // Tier 3 — heuristic, no network.
      const heuristic = heuristicMapValues(filtered)
      const reasons: string[] = []
      if (groqErr instanceof Error) reasons.push(`GROQ: ${groqErr.message}`)
      if (geminiErr instanceof Error)
        reasons.push(`Gemini: ${geminiErr.message}`)
      return {
        suggestions: heuristic.suggestions,
        warnings: [
          "AI value mapping unavailable, fell back to heuristic synonym matching. Review every value carefully.",
          ...tooMany,
          ...reasons,
        ],
        method: "heuristic",
      }
    }
  }
}

// ─── Heuristic tier ──────────────────────────────────────────────────────

function heuristicMapValues(
  columns: ValueMapperInputColumn[],
): { suggestions: Record<string, Record<string, ValueMappingSuggestion>> } {
  const suggestions: Record<
    string,
    Record<string, ValueMappingSuggestion>
  > = {}
  for (const col of columns) {
    const spec = CATEGORICAL_TARGETS[col.target]
    if (!spec) continue
    const perTarget: Record<string, ValueMappingSuggestion> = suggestions[col.target] ?? {}
    for (const raw of col.rawValues) {
      // Skip if we already have a mapping from a previous column with
      // the same target. Last column wins is fine but no need to
      // overwrite identical results.
      if (raw in perTarget) continue
      const match = heuristicMatchCategorical(spec, raw)
      perTarget[raw] = match
        ? { value: match, confidence: "medium", reason: "Synonym match" }
        : { value: null, confidence: "low", reason: "No synonym match" }
    }
    suggestions[col.target] = perTarget
  }
  return { suggestions }
}

// ─── GROQ tier ──────────────────────────────────────────────────────────

async function aiMapCsvValuesWithGroq(
  columns: ValueMapperInputColumn[],
): Promise<{
  suggestions: Record<string, Record<string, ValueMappingSuggestion>>
  warnings: string[]
}> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured.")
  }
  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL

  const prompt = buildValueMappingPrompt(columns)

  const response = await fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 3000,
      messages: [
        {
          role: "system",
          content:
            "You are a precise CSV value mapper. Output is always a single valid JSON object matching the exact shape requested by the user. Never include prose, never include markdown fences.",
        },
        { role: "user", content: prompt },
      ],
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    throw new Error(
      `Groq API returned ${response.status}: ${errorBody.slice(0, 200)}`,
    )
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = body.choices?.[0]?.message?.content
  if (!content || typeof content !== "string") {
    throw new Error("Groq returned an empty response.")
  }

  return parseValueMappingResponse(content, columns)
}

// ─── Gemini tier ────────────────────────────────────────────────────────

async function aiMapCsvValuesWithGemini(
  columns: ValueMapperInputColumn[],
): Promise<{
  suggestions: Record<string, Record<string, ValueMappingSuggestion>>
  warnings: string[]
}> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.")
  }
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`

  const prompt = buildValueMappingPrompt(columns)

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 3000,
        responseMimeType: "application/json",
        // Disable "thinking" — on 2.5 models it's on by default and can
        // eat the whole token budget, returning an empty completion.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    throw new Error(
      `Gemini API returned ${response.status}: ${errorBody.slice(0, 200)}`,
    )
  }

  const body = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> }
    }>
  }
  const content = body.candidates?.[0]?.content?.parts?.[0]?.text
  if (!content || typeof content !== "string") {
    throw new Error("Gemini returned an empty response.")
  }

  return parseValueMappingResponse(content, columns)
}

// ─── Prompt + parser ────────────────────────────────────────────────────

function buildValueMappingPrompt(columns: ValueMapperInputColumn[]): string {
  const columnBlocks = columns
    .map((c) => {
      const spec = CATEGORICAL_TARGETS[c.target] as CategoricalTargetSpec
      const allowedLines = spec.values.map((v) => `    - ${v}`).join("\n")
      const rawLines = c.rawValues.map((v) => `    - ${JSON.stringify(v)}`).join("\n")
      return `## Column: "${c.sourceColumn}" → target: ${c.target}
Description: ${spec.description}
Allowed canonical values (${spec.kind}):
${allowedLines}
Distinct raw values from the CSV:
${rawLines}`
    })
    .join("\n\n")

  return `For each CSV column below, map every distinct raw value to one of the allowed canonical values for its target field, or null if no canonical value fits.

${columnBlocks}

# Instructions
- For each column, return an entry per raw value with the canonical value (a string from the "Allowed canonical values" list) or null.
- Confidence rules:
    - "high" when the raw value is an obvious synonym or trivially equivalent (e.g. "Single" → SINGLE, "Yes" → TRUE).
    - "medium" when it's a reasonable interpretation but you had to disambiguate.
    - "low" when you're guessing. Prefer null over a low-confidence guess for safety-critical fields.
- "reason" should be ≤ 20 words and explain the choice in plain English.
- Flag anything unusual in the top-level "warnings" array (e.g. "column has 14 distinct values, possibly mismapped").

# Required output JSON shape
{
  "mappings": [
    {
      "target": "<target field key>",
      "sourceColumn": "<as in input>",
      "values": [
        { "raw": "<verbatim raw value>", "canonical": "<allowed value or null>", "confidence": "high"|"medium"|"low", "reason": "<short>" }
      ]
    }
  ],
  "warnings": ["<string>", ...]
}

Output ONLY the JSON object. No prose, no markdown.`
}

function parseValueMappingResponse(
  content: string,
  expected: ValueMapperInputColumn[],
): {
  suggestions: Record<string, Record<string, ValueMappingSuggestion>>
  warnings: string[]
} {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error("AI returned non-JSON output for the value-mapping request.")
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { mappings?: unknown }).mappings)
  ) {
    throw new Error("AI output did not match the expected value-mapping shape.")
  }

  const raw = parsed as {
    mappings: Array<{
      target?: unknown
      sourceColumn?: unknown
      values?: unknown
    }>
    warnings?: unknown
  }

  const suggestions: Record<string, Record<string, ValueMappingSuggestion>> = {}

  // Seed every expected (target, raw) pair with a low-confidence
  // "leave blank" default so the UI never has a missing dropdown.
  for (const col of expected) {
    suggestions[col.target] = suggestions[col.target] ?? {}
    for (const r of col.rawValues) {
      if (!(r in suggestions[col.target])) {
        suggestions[col.target][r] = {
          value: null,
          confidence: "low",
          reason: "Not returned by AI.",
        }
      }
    }
  }

  for (const m of raw.mappings) {
    if (typeof m.target !== "string") continue
    const spec = CATEGORICAL_TARGETS[m.target]
    if (!spec) continue
    const allowed = new Set<string>(spec.values)
    if (!Array.isArray(m.values)) continue
    const perTarget = suggestions[m.target] ?? {}
    for (const entry of m.values) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as {
        raw?: unknown
        canonical?: unknown
        confidence?: unknown
        reason?: unknown
      }
      if (typeof e.raw !== "string") continue
      const canonical =
        typeof e.canonical === "string" && allowed.has(e.canonical)
          ? e.canonical
          : null
      const confidence: MappingConfidence =
        e.confidence === "high" ||
        e.confidence === "medium" ||
        e.confidence === "low"
          ? e.confidence
          : "low"
      const reason = typeof e.reason === "string" ? e.reason : ""
      perTarget[e.raw] = {
        value: canonical,
        confidence,
        reason,
      }
    }
    suggestions[m.target] = perTarget
  }

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is string => typeof w === "string")
    : []

  return { suggestions, warnings }
}
