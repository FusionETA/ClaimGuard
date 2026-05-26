import "server-only"

/**
 * Server-only half of the CSV column mapper.
 *
 * The pure types + heuristic mapper live in `./csv-mapper` so the
 * client-side import dialog can read `FIELD_CATEGORIES`, `SchemaField`,
 * etc. without pulling a `server-only` module into the browser
 * bundle. This file holds the network-bound bits — GROQ + Gemini
 * provider calls — that must never ship to the client.
 *
 * Public surface: `aiMapCsvColumns(headers, sampleRows)`. The chain
 * is GROQ → Gemini → heuristic (the heuristic itself lives in
 * `./csv-mapper`).
 */

import {
  detectChildSlots,
  getTargetSchemaForHeaders,
  heuristicMapCsvColumns,
  type AiMappingResult,
  type ColumnMapping,
} from "./csv-mapper"

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
// gemini-2.5-flash is the current GA flash model. The old
// gemini-1.5-flash was retired by Google and now 404s — which is why
// the Groq→Gemini fallback used to error out. Override via GEMINI_MODEL.
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"

/**
 * Map the admin's source CSV columns to our schema with a three-tier
 * fallback chain:
 *
 *   1. GROQ          (primary, fastest, structured-JSON model)
 *   2. Gemini        (backup, used if GROQ fails for any reason)
 *   3. Heuristic     (no-network fallback that always returns; uses
 *                     synonym dict + fuzzy string matching)
 *
 * Returns the mapping + a `method` field telling the caller which
 * tier ended up producing the result. The UI surfaces this so admins
 * know how much to trust the suggestion before confirming.
 */
export async function aiMapCsvColumns(
  sourceHeaders: string[],
  sampleRows: string[][],
): Promise<AiMappingResult> {
  const detectedChildSlots = detectChildSlots(sourceHeaders)
  // Tier 1 — GROQ.
  try {
    const groq = await aiMapCsvColumnsWithGroq(sourceHeaders, sampleRows)
    return { ...groq, method: "groq", detectedChildSlots }
  } catch (groqErr) {
    // Tier 2 — Gemini.
    try {
      const gemini = await aiMapCsvColumnsWithGemini(sourceHeaders, sampleRows)
      return { ...gemini, method: "gemini", detectedChildSlots }
    } catch (geminiErr) {
      // Tier 3 — heuristic, no network. Always returns.
      const heuristic = heuristicMapCsvColumns(sourceHeaders)
      const reasons: string[] = []
      if (groqErr instanceof Error) reasons.push(`GROQ: ${groqErr.message}`)
      if (geminiErr instanceof Error)
        reasons.push(`Gemini: ${geminiErr.message}`)
      return {
        ...heuristic,
        warnings: [
          "AI mapping unavailable, fell back to heuristic matching. Review every column carefully.",
          ...reasons,
          ...heuristic.warnings,
        ],
        method: "heuristic",
        detectedChildSlots,
      }
    }
  }
}

async function aiMapCsvColumnsWithGroq(
  sourceHeaders: string[],
  sampleRows: string[][],
): Promise<Omit<AiMappingResult, "method" | "detectedChildSlots">> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured.")
  }
  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL

  const prompt = buildMappingPrompt(sourceHeaders, sampleRows)

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
            "You are a precise CSV column mapper. Output is always a single valid JSON object matching the exact shape requested by the user. Never include prose, never include markdown fences.",
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

  return parseMappingResponse(content, sourceHeaders)
}

async function aiMapCsvColumnsWithGemini(
  sourceHeaders: string[],
  sampleRows: string[][],
): Promise<Omit<AiMappingResult, "method" | "detectedChildSlots">> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.")
  }
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(
    model,
  )}:generateContent?key=${encodeURIComponent(apiKey)}`

  const prompt = buildMappingPrompt(sourceHeaders, sampleRows)

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

  return parseMappingResponse(content, sourceHeaders)
}

// ─── Prompt + response parser ────────────────────────────────────────────

function buildMappingPrompt(
  sourceHeaders: string[],
  sampleRows: string[][],
): string {
  const schema = getTargetSchemaForHeaders(sourceHeaders)
  const schemaLines = schema
    .map(
      (f) =>
        `  - ${f.key}${f.required ? " (REQUIRED)" : ""} [${f.category}]: ${f.description}`,
    )
    .join("\n")

  const sourceLines = sourceHeaders
    .map((h, i) => `  ${i + 1}. "${h}"`)
    .join("\n")

  const sampleSection =
    sampleRows.length > 0
      ? sourceHeaders
          .map((h, colIdx) => {
            const examples = sampleRows
              .slice(0, 3)
              .map((row) => row[colIdx] ?? "")
              .filter((v) => v.trim().length > 0)
              .slice(0, 3)
              .map((v) => `"${v.replace(/"/g, '\\"').slice(0, 60)}"`)
              .join(", ")
            return `  "${h}": [${examples}]`
          })
          .join("\n")
      : "(no sample data provided)"

  return `Map each source CSV column to its best matching target field.

# Target schema
${schemaLines}

# Source CSV columns (in order)
${sourceLines}

# Sample values per source column (for context)
${sampleSection}

# Instructions
- For each source column, pick exactly ONE target field key from the schema above, or null if nothing matches well.
- Multiple source columns CAN map to the same target field — but you should usually pick the best single source column per target.
- Use the sample values to disambiguate. E.g. a "Status" column with values "Married", "Single" maps to maritalStatus; a "Status" column with values "Active", "Inactive" probably maps to null.
- Confidence rules:
    - "high" when the column name + sample data clearly match.
    - "medium" when one of the two is ambiguous.
    - "low" when you're guessing.
- "reason" should be a short (≤ 20 words) explanation an English-speaking admin would understand.
- Also list any required schema fields that you couldn't find a source column for — put them as strings in the "warnings" array.

# Required output JSON shape
{
  "mappings": [
    { "sourceColumn": "<as in input>", "ourField": "<schema key or null>", "confidence": "high"|"medium"|"low", "reason": "<short>" }
  ],
  "warnings": ["<string>", ...]
}

Output ONLY the JSON object. No prose, no markdown.`
}

function parseMappingResponse(
  content: string,
  expectedSourceHeaders: string[],
): Omit<AiMappingResult, "method" | "detectedChildSlots"> {
  // GROQ should return raw JSON, but defensively strip ```json fences if any.
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error("Groq returned non-JSON output for the mapping request.")
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { mappings?: unknown }).mappings)
  ) {
    throw new Error("Groq output did not match the expected mapping shape.")
  }

  const raw = parsed as {
    mappings: Array<{
      sourceColumn?: unknown
      ourField?: unknown
      confidence?: unknown
      reason?: unknown
    }>
    warnings?: unknown
  }

  const validFields = new Set(
    getTargetSchemaForHeaders(expectedSourceHeaders).map((f) => f.key),
  )
  const cleanedMappings: ColumnMapping[] = raw.mappings.map((m) => {
    const sourceColumn =
      typeof m.sourceColumn === "string" ? m.sourceColumn : ""
    const ourFieldRaw = m.ourField
    const ourField =
      typeof ourFieldRaw === "string" && validFields.has(ourFieldRaw)
        ? ourFieldRaw
        : null
    const conf =
      m.confidence === "high" ||
      m.confidence === "medium" ||
      m.confidence === "low"
        ? m.confidence
        : "low"
    const reason = typeof m.reason === "string" ? m.reason : ""
    return {
      sourceColumn,
      ourField,
      confidence: conf,
      reason,
    }
  })

  // Reorder to match the original source header order. The model
  // usually preserves order but just in case.
  const indexByHeader = new Map<string, ColumnMapping>()
  for (const m of cleanedMappings) {
    indexByHeader.set(m.sourceColumn, m)
  }
  const orderedMappings: ColumnMapping[] = expectedSourceHeaders.map(
    (h) =>
      indexByHeader.get(h) ?? {
        sourceColumn: h,
        ourField: null,
        confidence: "low" as const,
        reason: "No mapping returned by AI.",
      },
  )

  // Safety net: whenever a source header EXACTLY matches a target
  // schema key, force-map to that key — regardless of what the AI
  // returned. We've observed both failure modes from GROQ on the
  // SAME response:
  //   • returning `ourField: null` for some exact matches
  //     (e.g. policyName → null), AND
  //   • returning a wrong non-null target for other exact matches
  //     (e.g. projectCode → employeeId).
  // An exact key match is canonical — admin renaming columns to our
  // exact key names is the universal "I know what this is" signal,
  // and the AI should never override that.
  const finalMappings: ColumnMapping[] = orderedMappings.map((m) => {
    if (validFields.has(m.sourceColumn) && m.ourField !== m.sourceColumn) {
      return {
        sourceColumn: m.sourceColumn,
        ourField: m.sourceColumn,
        confidence: "high" as const,
        reason: "Header matches our schema key exactly (auto-corrected).",
      }
    }
    return m
  })

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is string => typeof w === "string")
    : []

  return { mappings: finalMappings, warnings }
}
