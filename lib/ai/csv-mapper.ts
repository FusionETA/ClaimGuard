import "server-only"

/**
 * AI-powered CSV column mapper.
 *
 * Takes the admin's uploaded CSV headers + a few sample rows, sends
 * them to GROQ along with our target schema, and returns a per-column
 * mapping suggestion with a confidence rating.
 *
 * The mapping is a SUGGESTION — the admin reviews and overrides
 * before any import happens. Confidence helps the UI highlight rows
 * the admin should pay extra attention to.
 */

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"

/** Confidence ratings the model returns per column. */
export type MappingConfidence = "high" | "medium" | "low"

export type ColumnMapping = {
  /// The header name from the user's CSV.
  sourceColumn: string
  /// Our internal schema field key (e.g. "email", "dateOfBirth").
  /// `null` if the source column has no good match in our schema.
  ourField: string | null
  /// Model self-rated confidence in the mapping.
  confidence: MappingConfidence
  /// Short human-readable explanation — surfaced in the UI as a
  /// hover tooltip.
  reason: string
}

export type MappingMethod = "groq" | "gemini" | "heuristic"

export type AiMappingResult = {
  /// One entry per source column. Same order as the CSV header.
  mappings: ColumnMapping[]
  /// Optional warnings the model wants to flag (e.g. "no birth date
  /// column found").
  warnings: string[]
  /// Which provider/method actually produced this mapping. Surfaced
  /// in the UI so admins know whether to trust the suggestion blindly
  /// or scrutinise.
  method: MappingMethod
}

/**
 * Our complete target schema. The model is told to map source
 * columns to ONLY these keys (or null). Each entry has a short
 * description so the model knows what kind of data lives in each
 * field.
 */
const TARGET_SCHEMA: Array<{ key: string; required: boolean; description: string }> = [
  // Tier 1 — identity
  { key: "name", required: true, description: "Full legal name" },
  { key: "email", required: true, description: "Login email, must be unique" },
  { key: "employeeId", required: true, description: "Org-specific employee code, e.g. EMP-001" },
  { key: "jobTitle", required: true, description: "Job title / position / designation" },
  // Tier 2 — payroll readiness
  { key: "salaryType", required: true, description: "MONTHLY or HOURLY" },
  { key: "monthlySalary", required: false, description: "Monthly salary in MYR (when salaryType is MONTHLY)" },
  { key: "hourlyRate", required: false, description: "Hourly rate in MYR (when salaryType is HOURLY)" },
  { key: "joinDate", required: true, description: "Date employee joined (YYYY-MM-DD)" },
  { key: "nationality", required: true, description: "Country of citizenship, e.g. Malaysian, Indonesian" },
  { key: "dateOfBirth", required: true, description: "Date of birth (YYYY-MM-DD)" },
  // Tier 3 — statutory
  { key: "hasPr", required: false, description: "TRUE/FALSE — Permanent Resident status" },
  { key: "idType", required: false, description: "Identification type: NRIC, PASSPORT, ARMY_NO, POLICE_NO" },
  { key: "idNumber", required: false, description: "Identification number (NRIC / passport / etc.)" },
  { key: "epfNumber", required: false, description: "KWSP / EPF member number" },
  { key: "epfMemberBefore1998", required: false, description: "TRUE/FALSE — EPF member before 1 Aug 1998" },
  { key: "socsoScheme", required: false, description: "SOCSO scheme: EMPLOYMENT_INJURY_INVALIDITY (cat 1) or EMPLOYMENT_INJURY_ONLY (cat 2)" },
  { key: "socsoNumber", required: false, description: "PERKESO / SOCSO reference number" },
  { key: "contributeToEis", required: false, description: "TRUE/FALSE — contributes to EIS" },
  { key: "incomeTaxNumber", required: false, description: "LHDN income tax / PCB number" },
  { key: "isResident", required: false, description: "TRUE/FALSE — tax resident status" },
  { key: "isOku", required: false, description: "TRUE/FALSE — OKU (disabled) status" },
  // Tier 4 — bank
  { key: "bankName", required: false, description: "Bank name (e.g. Maybank, CIMB, RHB)" },
  { key: "bankAccountHolderName", required: false, description: "Bank account holder name" },
  { key: "bankAccountNumber", required: false, description: "Bank account number" },
  { key: "paymentMethod", required: false, description: "BANK_TRANSFER, CASH, or CHEQUE" },
  // Tier 5 — optional
  { key: "phone", required: false, description: "Phone or mobile number" },
  { key: "gender", required: false, description: "MALE or FEMALE" },
  { key: "race", required: false, description: "LHDN race code (M/C/I/O)" },
  { key: "maritalStatus", required: false, description: "SINGLE, MARRIED, DIVORCED, WIDOWED" },
  { key: "addressLine1", required: false, description: "Street address line 1" },
  { key: "addressLine2", required: false, description: "Street address line 2" },
  { key: "city", required: false, description: "City" },
  { key: "postcode", required: false, description: "Postcode" },
  { key: "state", required: false, description: "State" },
  { key: "department", required: false, description: "Department" },
  { key: "location", required: false, description: "Work location" },
  // Hierarchy
  { key: "projectCode", required: false, description: "Project name to assign the employee to" },
  { key: "teamCode", required: false, description: "Team name within the project" },
  { key: "supervisorEmployeeId", required: false, description: "Direct supervisor's employeeId code" },
]

export function getTargetSchema() {
  return TARGET_SCHEMA
}

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
  // Tier 1 — GROQ.
  try {
    const groq = await aiMapCsvColumnsWithGroq(sourceHeaders, sampleRows)
    return { ...groq, method: "groq" }
  } catch (groqErr) {
    // Tier 2 — Gemini.
    try {
      const gemini = await aiMapCsvColumnsWithGemini(sourceHeaders, sampleRows)
      return { ...gemini, method: "gemini" }
    } catch (geminiErr) {
      // Tier 3 — heuristic, no network. Always returns.
      const heuristic = heuristicMapCsvColumns(sourceHeaders)
      const reasons: string[] = []
      if (groqErr instanceof Error) reasons.push(`GROQ: ${groqErr.message}`)
      if (geminiErr instanceof Error) reasons.push(`Gemini: ${geminiErr.message}`)
      return {
        ...heuristic,
        warnings: [
          "AI mapping unavailable, fell back to heuristic matching. Review every column carefully.",
          ...reasons,
          ...heuristic.warnings,
        ],
        method: "heuristic",
      }
    }
  }
}

async function aiMapCsvColumnsWithGroq(
  sourceHeaders: string[],
  sampleRows: string[][],
): Promise<Omit<AiMappingResult, "method">> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not configured.",
    )
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

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
const DEFAULT_GEMINI_MODEL = "gemini-1.5-flash"

async function aiMapCsvColumnsWithGemini(
  sourceHeaders: string[],
  sampleRows: string[][],
): Promise<Omit<AiMappingResult, "method">> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.")
  }
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`

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

// ─── Heuristic fallback ─────────────────────────────────────────────────

/**
 * Synonym dictionary used when the AI is unavailable. Keys are
 * normalised (lowercase, alphanumeric only) source-header tokens;
 * values are the target schema field they map to. Multiple synonyms
 * can point at the same target.
 */
const HEURISTIC_SYNONYMS: Record<string, string> = {
  // Identity
  fullname: "name",
  employeename: "name",
  staffname: "name",
  name: "name",
  emailaddress: "email",
  email: "email",
  staffemail: "email",
  workemail: "email",
  employeecode: "employeeId",
  employeenumber: "employeeId",
  employeeid: "employeeId",
  staffid: "employeeId",
  empid: "employeeId",
  empno: "employeeId",
  staffnumber: "employeeId",
  jobtitle: "jobTitle",
  position: "jobTitle",
  designation: "jobTitle",
  title: "jobTitle",
  // Payroll readiness
  salarytype: "salaryType",
  paytype: "salaryType",
  remunerationtype: "salaryType",
  monthlysalary: "monthlySalary",
  salary: "monthlySalary",
  basicsalary: "monthlySalary",
  basicpay: "monthlySalary",
  basic: "monthlySalary",
  monthlypay: "monthlySalary",
  hourlyrate: "hourlyRate",
  hourlywage: "hourlyRate",
  ratehour: "hourlyRate",
  joindate: "joinDate",
  startdate: "joinDate",
  hiredate: "joinDate",
  employmentdate: "joinDate",
  dateofjoin: "joinDate",
  dateofjoining: "joinDate",
  nationality: "nationality",
  citizenship: "nationality",
  country: "nationality",
  dateofbirth: "dateOfBirth",
  dob: "dateOfBirth",
  birthdate: "dateOfBirth",
  birthday: "dateOfBirth",
  // Statutory
  haspr: "hasPr",
  pr: "hasPr",
  permanentresident: "hasPr",
  idtype: "idType",
  identificationtype: "idType",
  idnumber: "idNumber",
  ic: "idNumber",
  icnumber: "idNumber",
  nric: "idNumber",
  identificationnumber: "idNumber",
  passport: "idNumber",
  passportnumber: "idNumber",
  epfnumber: "epfNumber",
  kwspnumber: "epfNumber",
  epfno: "epfNumber",
  kwspno: "epfNumber",
  epfmember1998: "epfMemberBefore1998",
  epfmemberbefore1998: "epfMemberBefore1998",
  socsoscheme: "socsoScheme",
  socso: "socsoScheme",
  perkesoscheme: "socsoScheme",
  socsonumber: "socsoNumber",
  perkesonumber: "socsoNumber",
  socsono: "socsoNumber",
  eis: "contributeToEis",
  contributetoeis: "contributeToEis",
  taxnumber: "incomeTaxNumber",
  incometaxnumber: "incomeTaxNumber",
  lhdnnumber: "incomeTaxNumber",
  pcbnumber: "incomeTaxNumber",
  pcbno: "incomeTaxNumber",
  resident: "isResident",
  taxresident: "isResident",
  oku: "isOku",
  isoku: "isOku",
  disabled: "isOku",
  // Bank
  bankname: "bankName",
  bank: "bankName",
  accountholdername: "bankAccountHolderName",
  accountholder: "bankAccountHolderName",
  accountnumber: "bankAccountNumber",
  bankaccount: "bankAccountNumber",
  bankaccountnumber: "bankAccountNumber",
  paymentmethod: "paymentMethod",
  // Personal
  phone: "phone",
  phonenumber: "phone",
  mobile: "phone",
  contact: "phone",
  contactnumber: "phone",
  gender: "gender",
  sex: "gender",
  race: "race",
  ethnicity: "race",
  maritalstatus: "maritalStatus",
  married: "maritalStatus",
  addressline1: "addressLine1",
  address1: "addressLine1",
  address: "addressLine1",
  street: "addressLine1",
  addressline2: "addressLine2",
  address2: "addressLine2",
  city: "city",
  town: "city",
  postcode: "postcode",
  postalcode: "postcode",
  zipcode: "postcode",
  zip: "postcode",
  state: "state",
  province: "state",
  department: "department",
  dept: "department",
  division: "department",
  location: "location",
  office: "location",
  branch: "location",
  // Hierarchy
  projectcode: "projectCode",
  project: "projectCode",
  projectname: "projectCode",
  teamcode: "teamCode",
  team: "teamCode",
  teamname: "teamCode",
  supervisor: "supervisorEmployeeId",
  supervisorid: "supervisorEmployeeId",
  manager: "supervisorEmployeeId",
  managerid: "supervisorEmployeeId",
  reportsto: "supervisorEmployeeId",
}

function normaliseHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Heuristic, offline column mapper. Used when both AI providers are
 * unreachable. Strategy per source header:
 *
 *   1. Exact match against our schema field keys (e.g. "email" → email).
 *   2. Normalised synonym lookup ("Email Address" → "emailaddress" → email).
 *   3. Substring containment ("staff_dob_iso" includes "dob" → dateOfBirth).
 *   4. null if nothing fits.
 *
 * Confidence: "high" for exact / synonym hits, "medium" for
 * substring, "low" when there's a near miss but no good match.
 */
export function heuristicMapCsvColumns(
  sourceHeaders: string[],
): Omit<AiMappingResult, "method"> {
  const fieldKeys = new Set(TARGET_SCHEMA.map((f) => f.key))
  const fieldKeysNormalised = new Map(
    TARGET_SCHEMA.map((f) => [normaliseHeader(f.key), f.key]),
  )

  const mappings: ColumnMapping[] = sourceHeaders.map((h) => {
    const normalised = normaliseHeader(h)

    // 1. Exact match against target key (case-insensitive).
    if (fieldKeys.has(h)) {
      return {
        sourceColumn: h,
        ourField: h,
        confidence: "high",
        reason: "Header matches our schema key exactly.",
      }
    }
    const exactNorm = fieldKeysNormalised.get(normalised)
    if (exactNorm) {
      return {
        sourceColumn: h,
        ourField: exactNorm,
        confidence: "high",
        reason: "Normalised header matches schema key.",
      }
    }

    // 2. Synonym dictionary.
    const synonym = HEURISTIC_SYNONYMS[normalised]
    if (synonym) {
      return {
        sourceColumn: h,
        ourField: synonym,
        confidence: "high",
        reason: `Recognised synonym for ${synonym}.`,
      }
    }

    // 3. Substring containment — pick the longest synonym key that's a
    // substring of the normalised header.
    const candidates = Object.keys(HEURISTIC_SYNONYMS)
      .filter((k) => normalised.includes(k) && k.length >= 3)
      .sort((a, b) => b.length - a.length)
    if (candidates.length > 0) {
      const target = HEURISTIC_SYNONYMS[candidates[0]]
      return {
        sourceColumn: h,
        ourField: target,
        confidence: "medium",
        reason: `Header contains a recognised token for ${target}.`,
      }
    }

    // 4. Substring against the schema field keys themselves.
    for (const f of TARGET_SCHEMA) {
      const fnorm = normaliseHeader(f.key)
      if (fnorm.length >= 4 && normalised.includes(fnorm)) {
        return {
          sourceColumn: h,
          ourField: f.key,
          confidence: "medium",
          reason: `Header contains the schema key "${f.key}".`,
        }
      }
    }

    return {
      sourceColumn: h,
      ourField: null,
      confidence: "low",
      reason: "No match — please pick manually.",
    }
  })

  // Surface required-field gaps as warnings.
  const mappedTargets = new Set(
    mappings.map((m) => m.ourField).filter((x): x is string => x != null),
  )
  const warnings: string[] = []
  for (const f of TARGET_SCHEMA) {
    if (f.required && !mappedTargets.has(f.key)) {
      warnings.push(`Required field "${f.key}" not matched to any source column.`)
    }
  }
  return { mappings, warnings }
}

// ─── Prompt + response parser ────────────────────────────────────────────

function buildMappingPrompt(
  sourceHeaders: string[],
  sampleRows: string[][],
): string {
  const schemaLines = TARGET_SCHEMA.map(
    (f) =>
      `  - ${f.key}${f.required ? " (REQUIRED)" : ""}: ${f.description}`,
  ).join("\n")

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
): Omit<AiMappingResult, "method"> {
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

  const validFields = new Set(TARGET_SCHEMA.map((f) => f.key))
  const cleanedMappings: ColumnMapping[] = raw.mappings.map((m) => {
    const sourceColumn =
      typeof m.sourceColumn === "string" ? m.sourceColumn : ""
    const ourFieldRaw = m.ourField
    const ourField =
      typeof ourFieldRaw === "string" && validFields.has(ourFieldRaw)
        ? ourFieldRaw
        : null
    const conf =
      m.confidence === "high" || m.confidence === "medium" || m.confidence === "low"
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

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w): w is string => typeof w === "string")
    : []

  return { mappings: orderedMappings, warnings }
}
