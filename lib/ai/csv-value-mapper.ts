/**
 * CSV value mapper — pure / shared half.
 *
 * Sister file to `./csv-mapper.ts`. Where `csv-mapper` handles
 * COLUMN-level mapping (which CSV column maps to which schema field),
 * this file handles VALUE-level mapping (e.g. "Employed" → `TRUE`,
 * "Single" → `SINGLE`).
 *
 * Holds public types, the canonical enum allowlists per target field,
 * and the heuristic / offline value mapper. NO network calls and NO
 * `server-only` marker — this module ships to both the browser bundle
 * (so the import dialog can render the value-mapping step) and the
 * server.
 *
 * The AI-provider half (GROQ + Gemini fetches) lives in
 * `./csv-value-mapper-ai`, which DOES carry the `server-only` marker.
 *
 * The mapping is a SUGGESTION — the admin reviews and confirms before
 * any import happens. Confidence helps the UI highlight rows the admin
 * should pay extra attention to.
 */

import type { MappingConfidence, MappingMethod } from "./csv-mapper"

/**
 * The shape sent back to the wizard once the AI (or heuristic) has
 * proposed a mapping for every distinct raw value in every
 * enum/boolean column.
 *
 * Outer key: target field key (e.g. "maritalStatus", "contributeToEpf").
 * Inner key: the raw value as it appears in the CSV (e.g. "Single",
 * "Married w/ kids", "Yes", "Y").
 * Inner value: { value, confidence, reason } where `value` is the
 * canonical enum value our schema accepts (e.g. "MARRIED", "TRUE"), or
 * `null` to mean "leave this cell blank / don't import".
 */
export type ValueMappingSuggestion = {
  value: string | null
  confidence: MappingConfidence
  reason: string
}

export type ValueMappingResult = {
  suggestions: Record<string, Record<string, ValueMappingSuggestion>>
  warnings: string[]
  method: MappingMethod
}

/**
 * The admin-confirmed value map, passed alongside `csv + mapping` to
 * `previewMappedCsv` / `importMappedCsv`.
 *
 * Outer key: target field key.
 * Inner key: raw value (verbatim from the CSV, post-trim).
 * Inner value: canonical enum value, or `null` to leave the cell blank.
 *
 * A missing entry means "fall back to the importer's hardcoded
 * normaliser synonyms" — this preserves backwards compatibility with
 * the legacy template-shaped CSV path.
 */
export type ValueMap = Record<string, Record<string, string | null>>

/**
 * Per-row reference overrides set by the admin in the preview step.
 *
 * Key: 0-based row index in the post-skipped, post-error preview
 * order. The wizard's preview table is the source of truth for this
 * index — `rowOverrides[i]` corresponds to the i-th row the admin sees
 * in preview, NOT the i-th line of the raw CSV.
 *
 * When `policyId` / `projectId` / `teamId` is present on a row, the
 * importer uses that ID directly and SKIPS the CSV-name → DB lookup
 * for that field. `teamLayer` overrides the CSV's layer column.
 */
export type RowOverrides = Record<
  number,
  {
    policyId?: string
    projectId?: string
    teamId?: string
    teamLayer?: number
  }
>

// ─── Canonical allowlists per categorical target ─────────────────────────
//
// Single source of truth for the enum/boolean values each schema field
// accepts. Consumed by:
//
//   • `lib/ai/csv-value-mapper-ai.ts` — to build the GROQ / Gemini prompt
//     and to constrain the heuristic fallback.
//   • The wizard's Map-values step — to render the per-rawValue
//     dropdown options.
//   • `modules/payroll/application/services/payroll-import.service.ts` —
//     `normaliseValue()` consults `valueMap` first, then falls back to
//     the synonyms here.
//
// Add a new categorical field by appending an entry here — everything
// downstream picks it up automatically.

export type CategoricalKind = "enum" | "boolean"

export type CategoricalTargetSpec = {
  /**
   * "boolean" fields always have values `["TRUE", "FALSE"]`. Surfaced
   * as a separate kind so the UI can label them "Yes / No" rather than
   * the raw enum strings.
   */
  kind: CategoricalKind
  /** Canonical values our Zod schema accepts. */
  values: readonly string[]
  /** Short human-readable description — surfaced in AI prompts. */
  description: string
  /**
   * Lowercase synonyms per canonical value. Used by the heuristic
   * fallback when no AI provider is available, and to populate the
   * initial `valueMap` if the admin clicks "Auto-fill from synonyms".
   */
  synonyms: Record<string, readonly string[]>
}

const BOOLEAN_SYNONYMS: Record<string, readonly string[]> = {
  TRUE: ["true", "1", "yes", "y", "ya", "active", "tick", "x", "✓", "✔"],
  FALSE: ["false", "0", "no", "n", "tidak", "inactive", "—", "-"],
}

const BOOLEAN_DESCRIPTIONS: Record<string, string> = {
  hasPr: "Permanent Resident status",
  epfMemberBefore1998: "EPF member before 1 Aug 1998",
  contributeToEis: "Contributes to EIS",
  isResident: "Tax resident status",
  isOku: "OKU (disabled) status",
  reportedToLhdn: "Final payroll reported to LHDN",
  spouseWorking: "Spouse is working / employed",
  spouseDisabled: "Spouse is OKU / disabled",
  contributeToEpf: "Contributes to EPF",
  pcbBorneByEmployer: "PCB is borne by the employer",
}

function booleanSpec(description: string): CategoricalTargetSpec {
  return {
    kind: "boolean",
    values: ["TRUE", "FALSE"],
    description,
    synonyms: BOOLEAN_SYNONYMS,
  }
}

export const CATEGORICAL_TARGETS: Record<string, CategoricalTargetSpec> = {
  // ── Non-boolean enums ──
  salaryType: {
    kind: "enum",
    values: ["MONTHLY", "HOURLY"],
    description: "Salary computation basis: MONTHLY or HOURLY",
    synonyms: {
      MONTHLY: ["monthly", "month", "m", "salaried"],
      HOURLY: ["hourly", "hour", "h", "per hour"],
    },
  },
  gender: {
    kind: "enum",
    values: ["MALE", "FEMALE"],
    description: "Gender: MALE or FEMALE",
    synonyms: {
      MALE: ["male", "m", "man", "lelaki"],
      FEMALE: ["female", "f", "woman", "perempuan"],
    },
  },
  maritalStatus: {
    kind: "enum",
    values: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"],
    description: "Marital status",
    synonyms: {
      SINGLE: ["single", "bujang", "never married"],
      MARRIED: ["married", "kahwin"],
      DIVORCED: ["divorced", "bercerai"],
      WIDOWED: ["widowed", "widow", "balu", "duda"],
    },
  },
  idType: {
    kind: "enum",
    values: ["NRIC", "PASSPORT", "ARMY_NO", "POLICE_NO"],
    description: "Identification type",
    synonyms: {
      NRIC: ["nric", "ic", "mykad", "kad pengenalan"],
      PASSPORT: ["passport", "pasport"],
      ARMY_NO: ["army", "tentera", "army_no"],
      POLICE_NO: ["police", "polis", "police_no"],
    },
  },
  socsoScheme: {
    kind: "enum",
    values: ["EMPLOYMENT_INJURY_INVALIDITY", "EMPLOYMENT_INJURY_ONLY"],
    description:
      "SOCSO scheme: EMPLOYMENT_INJURY_INVALIDITY (cat 1) or EMPLOYMENT_INJURY_ONLY (cat 2)",
    synonyms: {
      EMPLOYMENT_INJURY_INVALIDITY: [
        "employment injury and invalidity",
        "employment injury & invalidity",
        "cat 1",
        "category 1",
        "first category",
        "scheme 1",
      ],
      EMPLOYMENT_INJURY_ONLY: [
        "employment injury only",
        "cat 2",
        "category 2",
        "second category",
        "scheme 2",
      ],
    },
  },
  paymentMethod: {
    kind: "enum",
    values: ["BANK_TRANSFER", "CASH", "CHEQUE"],
    description: "Payment method",
    synonyms: {
      BANK_TRANSFER: [
        "bank transfer",
        "bank",
        "transfer",
        "giro",
        "online transfer",
      ],
      CASH: ["cash", "tunai"],
      CHEQUE: ["cheque", "check"],
    },
  },
  employeeType: {
    kind: "enum",
    values: ["EMPLOYEE", "SUPERVISOR"],
    description:
      "Employee classification: EMPLOYEE (regular staff) or SUPERVISOR (manages a team)",
    synonyms: {
      EMPLOYEE: [
        "employee",
        "basic",
        "basic employee",
        "regular",
        "regular employee",
        "staff",
        "worker",
        "user",
        "normal",
      ],
      SUPERVISOR: [
        "supervisor",
        "supervisor employee",
        "manager",
        "lead",
        "team lead",
        "team leader",
        "head",
      ],
    },
  },

  // ── Booleans ──
  hasPr: booleanSpec(BOOLEAN_DESCRIPTIONS.hasPr),
  epfMemberBefore1998: booleanSpec(BOOLEAN_DESCRIPTIONS.epfMemberBefore1998),
  contributeToEis: booleanSpec(BOOLEAN_DESCRIPTIONS.contributeToEis),
  isResident: booleanSpec(BOOLEAN_DESCRIPTIONS.isResident),
  isOku: booleanSpec(BOOLEAN_DESCRIPTIONS.isOku),
  reportedToLhdn: booleanSpec(BOOLEAN_DESCRIPTIONS.reportedToLhdn),
  spouseWorking: booleanSpec(BOOLEAN_DESCRIPTIONS.spouseWorking),
  spouseDisabled: booleanSpec(BOOLEAN_DESCRIPTIONS.spouseDisabled),
  contributeToEpf: booleanSpec(BOOLEAN_DESCRIPTIONS.contributeToEpf),
  pcbBorneByEmployer: booleanSpec(BOOLEAN_DESCRIPTIONS.pcbBorneByEmployer),
}

/**
 * Look up the spec for a target field. Returns `null` for fields that
 * are not categorical (free text, numbers, dates, references).
 */
export function getCategoricalTargetSpec(
  target: string,
): CategoricalTargetSpec | null {
  return CATEGORICAL_TARGETS[target] ?? null
}

/**
 * Heuristic value normaliser — used by both the importer's fallback
 * path (when no `valueMap` is supplied) and the AI mapper's heuristic
 * tier (when GROQ + Gemini are both unavailable).
 *
 * Lowercase-matches `raw` against the spec's synonym lists and returns
 * the canonical enum value, or `null` when nothing matches.
 */
export function heuristicMatchCategorical(
  spec: CategoricalTargetSpec,
  raw: string,
): string | null {
  const needle = raw.trim().toLowerCase()
  if (needle === "") return null
  // Exact canonical match first (case-insensitive).
  for (const canonical of spec.values) {
    if (canonical.toLowerCase() === needle) return canonical
  }
  // Then synonyms.
  for (const [canonical, list] of Object.entries(spec.synonyms)) {
    if (list.includes(needle)) return canonical
  }
  return null
}
