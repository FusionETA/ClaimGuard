/**
 * CSV column mapper — pure / shared half.
 *
 * Holds the public types, the target schema, the heuristic / offline
 * column mapper, and the dynamic dependent-child slot detector. NO
 * network calls and NO `server-only` marker — this module ships to
 * both the browser bundle (so the import dialog can render
 * `FIELD_CATEGORIES` / `SchemaField`) and the server.
 *
 * The AI-provider half (GROQ + Gemini fetches) lives in
 * `./csv-mapper-ai`, which DOES carry the `server-only` marker.
 *
 * The mapping is a SUGGESTION — the admin reviews and overrides
 * before any import happens. Confidence helps the UI highlight rows
 * the admin should pay extra attention to.
 */

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
  /// Dependent-child slot numbers detected in the source headers
  /// (e.g. [1,2,3,4] when the CSV has "Dependent Child 1 - Age" …
  /// "Dependent Child 4 - PCB Deduction" columns). The UI uses this
  /// to render the Spouse & Dependents tab with the right number of
  /// child slots.
  detectedChildSlots: number[]
}

/**
 * Field categories — drive both the optgroup labels in the mapping
 * dropdown and the row-filter tab strip in the dialog. Order is the
 * visual order of tabs / option groups.
 */
export const FIELD_CATEGORIES = [
  "Identity & Employment",
  "Personal & Contact",
  "Spouse & Dependents",
  "Statutory & Payroll",
  "Bank",
  "Hierarchy",
] as const
export type FieldCategory = (typeof FIELD_CATEGORIES)[number]

export type SchemaField = {
  key: string
  required: boolean
  description: string
  category: FieldCategory
}

/**
 * Our complete target schema. The model is told to map source
 * columns to ONLY these keys (or null). Each entry has a short
 * description so the model knows what kind of data lives in each
 * field, plus a `category` used to group fields in the UI dropdown
 * (via <optgroup>) and the row-filter tab strip.
 *
 * The dependent-children entries are NOT in this static list — they
 * are generated on the fly by `getTargetSchemaForHeaders()` based on
 * the actual "Dependent Child N" columns detected in the uploaded
 * CSV. This avoids hardcoding a max-children cap and supports any N
 * the file contains.
 */
const TARGET_SCHEMA: SchemaField[] = [
  // ── Identity & Employment ──
  { key: "name", required: true, description: "Full legal name", category: "Identity & Employment" },
  { key: "email", required: true, description: "Login email, must be unique", category: "Identity & Employment" },
  { key: "employeeId", required: true, description: "Org-specific employee code, e.g. EMP-001", category: "Identity & Employment" },
  { key: "jobTitle", required: true, description: "Job title / position / designation", category: "Identity & Employment" },
  { key: "employeeType", required: true, description: "EMPLOYEE or SUPERVISOR — admins cannot be created via import", category: "Identity & Employment" },
  { key: "joinDate", required: true, description: "Date employee joined (YYYY-MM-DD)", category: "Identity & Employment" },
  { key: "leaveDate", required: false, description: "Last day of employment (YYYY-MM-DD) — fill when archiving an employee", category: "Identity & Employment" },
  { key: "archiveReason", required: false, description: "Reason for leaving — only used when leaveDate is set", category: "Identity & Employment" },
  { key: "reportedToLhdn", required: false, description: "TRUE/FALSE — whether final payroll has been reported to LHDN", category: "Identity & Employment" },

  // ── Personal & Contact ──
  { key: "dateOfBirth", required: true, description: "Date of birth (YYYY-MM-DD)", category: "Personal & Contact" },
  { key: "gender", required: false, description: "MALE or FEMALE", category: "Personal & Contact" },
  { key: "race", required: false, description: "LHDN race code (M/C/I/O)", category: "Personal & Contact" },
  { key: "nationality", required: true, description: "Country of citizenship, e.g. Malaysian, Indonesian", category: "Personal & Contact" },
  { key: "maritalStatus", required: false, description: "SINGLE, MARRIED, DIVORCED, WIDOWED", category: "Personal & Contact" },
  { key: "hasPr", required: false, description: "TRUE/FALSE — Permanent Resident status", category: "Personal & Contact" },
  { key: "isResident", required: false, description: "TRUE/FALSE — tax resident status", category: "Personal & Contact" },
  { key: "isOku", required: false, description: "TRUE/FALSE — OKU (disabled) status", category: "Personal & Contact" },
  { key: "idType", required: false, description: "Identification type: NRIC, PASSPORT, ARMY_NO, POLICE_NO", category: "Personal & Contact" },
  { key: "idNumber", required: false, description: "Identification number (NRIC / passport / etc.)", category: "Personal & Contact" },
  { key: "alternateEmail", required: false, description: "Personal / alternate email address", category: "Personal & Contact" },
  { key: "phone", required: false, description: "Phone or mobile number", category: "Personal & Contact" },
  { key: "addressLine1", required: false, description: "Street address line 1", category: "Personal & Contact" },
  { key: "addressLine2", required: false, description: "Street address line 2", category: "Personal & Contact" },
  { key: "addressLine3", required: false, description: "Street address line 3", category: "Personal & Contact" },
  { key: "city", required: false, description: "City", category: "Personal & Contact" },
  { key: "postcode", required: false, description: "Postcode", category: "Personal & Contact" },
  { key: "state", required: false, description: "State", category: "Personal & Contact" },
  { key: "emergencyContactName", required: false, description: "Emergency contact full name", category: "Personal & Contact" },
  { key: "emergencyContactPhone", required: false, description: "Emergency contact phone number", category: "Personal & Contact" },
  { key: "emergencyContactRelation", required: false, description: "Emergency contact relationship (Parent, Spouse, Sibling, etc.)", category: "Personal & Contact" },

  // ── Spouse & Dependents ──
  // Per-child slots (childN.age etc.) are added dynamically by
  // getTargetSchemaForHeaders() based on the uploaded file's columns.
  { key: "spouseWorking", required: false, description: "TRUE/FALSE — is the employee's spouse working / employed?", category: "Spouse & Dependents" },
  { key: "spouseDisabled", required: false, description: "TRUE/FALSE — is the employee's spouse OKU / disabled?", category: "Spouse & Dependents" },
  { key: "spousePcbNumber", required: false, description: "Spouse's LHDN PCB number (used in PCB joint-assessment calcs)", category: "Spouse & Dependents" },
  { key: "spouseIdNumber", required: false, description: "Spouse's NRIC / passport number", category: "Spouse & Dependents" },

  // ── Statutory & Payroll ──
  { key: "salaryType", required: true, description: "MONTHLY or HOURLY", category: "Statutory & Payroll" },
  { key: "monthlySalary", required: false, description: "Monthly salary in MYR (when salaryType is MONTHLY)", category: "Statutory & Payroll" },
  { key: "hourlyRate", required: false, description: "Hourly rate in MYR (when salaryType is HOURLY)", category: "Statutory & Payroll" },
  { key: "contributeToEpf", required: false, description: "TRUE/FALSE — whether the employee contributes to EPF", category: "Statutory & Payroll" },
  { key: "epfNumber", required: false, description: "KWSP / EPF member number", category: "Statutory & Payroll" },
  { key: "epfMemberBefore1998", required: false, description: "TRUE/FALSE — EPF member before 1 Aug 1998", category: "Statutory & Payroll" },
  { key: "epfEmployeeRate", required: false, description: "Employee EPF rate %, default 11 — accepts '11', '11%', '0.11'", category: "Statutory & Payroll" },
  { key: "epfEmployeeVoluntary", required: false, description: "Voluntary EPF % on top of mandatory rate", category: "Statutory & Payroll" },
  { key: "epfEmployerVoluntary", required: false, description: "Voluntary employer EPF % on top of mandatory rate", category: "Statutory & Payroll" },
  { key: "pcbBorneByEmployer", required: false, description: "TRUE/FALSE — PCB is borne by the employer", category: "Statutory & Payroll" },
  { key: "incomeTaxNumber", required: false, description: "LHDN income tax / PCB number", category: "Statutory & Payroll" },
  { key: "socsoScheme", required: false, description: "SOCSO scheme: EMPLOYMENT_INJURY_INVALIDITY (cat 1) or EMPLOYMENT_INJURY_ONLY (cat 2)", category: "Statutory & Payroll" },
  { key: "socsoNumber", required: false, description: "PERKESO / SOCSO reference number", category: "Statutory & Payroll" },
  { key: "contributeToEis", required: false, description: "TRUE/FALSE — contributes to EIS", category: "Statutory & Payroll" },
  { key: "ssfwNumber", required: false, description: "SSFW (Social Security for Foreign Workers) number — foreign employees only", category: "Statutory & Payroll" },

  // ── Bank ──
  { key: "bankName", required: false, description: "Bank name (e.g. Maybank, CIMB, RHB)", category: "Bank" },
  { key: "bankAccountHolderName", required: false, description: "Bank account holder name (same as 'Account Name')", category: "Bank" },
  { key: "bankAccountNumber", required: false, description: "Bank account number", category: "Bank" },
  { key: "paymentMethod", required: false, description: "BANK_TRANSFER, CASH, or CHEQUE", category: "Bank" },

  // ── Hierarchy ──
  // All four end up on the EmployeeProfile. They stay flagged
  // `required` so the schema documents the desired end state, but the
  // import wizard treats them as PREVIEW-PICKABLE — the admin can
  // either map a CSV column or assign them per-row in the preview
  // step's picker (which also supports inline "+ Create new"). The
  // column-mapping step does NOT block on these being unmapped.
  { key: "policyName", required: true, description: "Employee policy name — pick a CSV column, or set it per-row in the preview picker (inline + Create supported)", category: "Hierarchy" },
  { key: "projectCode", required: true, description: "Project name — pick a CSV column, or set it per-row in the preview picker (inline + Create supported)", category: "Hierarchy" },
  { key: "teamCode", required: true, description: "Team name within the project — pick a CSV column, or set it per-row in the preview picker (inline + Create supported)", category: "Hierarchy" },
  { key: "teamLayer", required: true, description: "Hierarchy layer this employee sits on within the team (1 = bottom, must be ≤ team.layerCount). Set in preview if no CSV column.", category: "Hierarchy" },
]

/// Sub-fields per detected child slot. Kept here so detect/getSchema/
/// heuristic stay in sync.
const CHILD_SUBFIELDS = [
  { suffix: "age", description: "Age in years (number)" },
  {
    suffix: "abilityStatus",
    description:
      "Child ability: NORMAL or DISABLED (accepts 'Non-disabled' / 'Disabled')",
  },
  {
    suffix: "currentlyStudying",
    description:
      "Education stage: PRESCHOOL, PRIMARY, SECONDARY, HIGHER_ED, or NONE",
  },
  {
    suffix: "pcbDeduction",
    description: "PCB child-relief deduction: FULL, HALF, or NONE",
  },
] as const

/**
 * Scan the uploaded CSV headers for "Dependent Child N", "Child N",
 * "Child_N", etc. patterns and return the distinct slot numbers.
 *
 * No cap on N — a file with 12 children produces 12 slots. Slots are
 * returned sorted ascending so the dropdown ordering is stable.
 */
export function detectChildSlots(headers: string[]): number[] {
  const found = new Set<number>()
  const pattern = /(?:dependent\s*child|child)[\s_\-.#]*?(\d+)/i
  for (const h of headers) {
    const m = h.match(pattern)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n > 0 && n < 100) found.add(n)
    }
  }
  return [...found].sort((a, b) => a - b)
}

/**
 * Build the per-file target schema by appending dynamic `childN.*`
 * slots for every child number detected in the uploaded headers. The
 * static fields above are returned first; the child slots are
 * appended in numeric order. Pass an empty headers list (or skip the
 * call) to get the static schema only.
 */
export function getTargetSchemaForHeaders(headers: string[]): SchemaField[] {
  const slots = detectChildSlots(headers)
  if (slots.length === 0) return TARGET_SCHEMA
  const childFields: SchemaField[] = slots.flatMap((n) =>
    CHILD_SUBFIELDS.map((f) => ({
      key: `child${n}.${f.suffix}`,
      required: false,
      description: `Dependent child ${n} — ${f.description}`,
      category: "Spouse & Dependents" as const,
    })),
  )
  return [...TARGET_SCHEMA, ...childFields]
}

/// Legacy alias for callers that don't have header context yet.
/// Equivalent to `getTargetSchemaForHeaders([])` — returns the static
/// schema without any dynamic child slots.
export function getTargetSchema(): SchemaField[] {
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
// ─── Heuristic fallback ─────────────────────────────────────────────────
// Network-bound providers (GROQ + Gemini) and the prompt/response
// machinery live in `./csv-mapper-ai`; this module only ships pure,
// client-safe code.

/**
 * Synonym dictionary used when the AI is unavailable. Keys are
 * normalised (lowercase, alphanumeric only) source-header tokens;
 * values are the target schema field they map to. Multiple synonyms
 * can point at the same target.
 */
const HEURISTIC_SYNONYMS: Record<string, string> = {
  // Identity & employment
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
  employeetype: "employeeType",
  employmenttype: "employeeType",
  role: "employeeType",
  userrole: "employeeType",
  staffrole: "employeeType",
  staffcategory: "employeeType",
  category: "employeeType",
  level: "employeeType",
  rank: "employeeType",
  joindate: "joinDate",
  startdate: "joinDate",
  hiredate: "joinDate",
  employmentdate: "joinDate",
  dateofjoin: "joinDate",
  dateofjoining: "joinDate",
  leavedate: "leaveDate",
  lastday: "leaveDate",
  enddate: "leaveDate",
  terminationdate: "leaveDate",
  resignationdate: "leaveDate",
  archivereason: "archiveReason",
  reason: "archiveReason",
  leavereason: "archiveReason",
  reportedtolhdn: "reportedToLhdn",
  lhdnreported: "reportedToLhdn",
  // Payroll readiness
  salarytype: "salaryType",
  paytype: "salaryType",
  remunerationtype: "salaryType",
  salarywagefrequency: "salaryType",
  wagefrequency: "salaryType",
  monthlysalary: "monthlySalary",
  salary: "monthlySalary",
  basicsalary: "monthlySalary",
  basicpay: "monthlySalary",
  basic: "monthlySalary",
  monthlypay: "monthlySalary",
  salarywageamount: "monthlySalary",
  hourlyrate: "hourlyRate",
  hourlywage: "hourlyRate",
  ratehour: "hourlyRate",
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
  contributetoepf: "contributeToEpf",
  contributingtoepf: "contributeToEpf",
  epfcontribute: "contributeToEpf",
  epfcontribution: "contributeToEpf",
  epfnumber: "epfNumber",
  kwspnumber: "epfNumber",
  epfno: "epfNumber",
  kwspno: "epfNumber",
  epfmember1998: "epfMemberBefore1998",
  epfmemberbefore1998: "epfMemberBefore1998",
  epfmemberbeforeaugust1998: "epfMemberBefore1998",
  employeeepfrate: "epfEmployeeRate",
  epfrate: "epfEmployeeRate",
  epfemployeerate: "epfEmployeeRate",
  voluntaryepfemployee: "epfEmployeeVoluntary",
  voluntaryemployeeepfrate: "epfEmployeeVoluntary",
  epfemployeevoluntary: "epfEmployeeVoluntary",
  voluntaryepfemployer: "epfEmployerVoluntary",
  voluntaryemployerepfrate: "epfEmployerVoluntary",
  epfemployervoluntary: "epfEmployerVoluntary",
  pcbbornebyemployer: "pcbBorneByEmployer",
  pcbborneemployer: "pcbBorneByEmployer",
  socsoscheme: "socsoScheme",
  socso: "socsoScheme",
  perkesoscheme: "socsoScheme",
  socsocontribution: "socsoScheme",
  socsonumber: "socsoNumber",
  perkesonumber: "socsoNumber",
  socsono: "socsoNumber",
  eis: "contributeToEis",
  contributetoeis: "contributeToEis",
  contributingtoeis: "contributeToEis",
  eiscontribute: "contributeToEis",
  ssfwnumber: "ssfwNumber",
  ssfw: "ssfwNumber",
  ssfwno: "ssfwNumber",
  taxnumber: "incomeTaxNumber",
  incometaxnumber: "incomeTaxNumber",
  lhdnnumber: "incomeTaxNumber",
  pcbnumber: "incomeTaxNumber",
  pcbno: "incomeTaxNumber",
  resident: "isResident",
  taxresident: "isResident",
  residentialstatus: "isResident",
  oku: "isOku",
  isoku: "isOku",
  disabled: "isOku",
  abilitystatus: "isOku",
  // Bank
  bankname: "bankName",
  bank: "bankName",
  accountholdername: "bankAccountHolderName",
  accountholder: "bankAccountHolderName",
  accountname: "bankAccountHolderName",
  accountnumber: "bankAccountNumber",
  bankaccount: "bankAccountNumber",
  bankaccountnumber: "bankAccountNumber",
  paymentmethod: "paymentMethod",
  // Personal
  alternateemail: "alternateEmail",
  personalemail: "alternateEmail",
  secondaryemail: "alternateEmail",
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
  addressline3: "addressLine3",
  address3: "addressLine3",
  city: "city",
  town: "city",
  postcode: "postcode",
  postalcode: "postcode",
  zipcode: "postcode",
  zip: "postcode",
  state: "state",
  province: "state",
  emergencycontactname: "emergencyContactName",
  emergencyname: "emergencyContactName",
  emergencycontact: "emergencyContactName",
  emergencycontactnumber: "emergencyContactPhone",
  emergencycontactphone: "emergencyContactPhone",
  emergencyphone: "emergencyContactPhone",
  emergencynumber: "emergencyContactPhone",
  emergencycontactrelation: "emergencyContactRelation",
  emergencyrelation: "emergencyContactRelation",
  emergencyrelationship: "emergencyContactRelation",
  // Spouse
  spousepcbnumber: "spousePcbNumber",
  emergencycontactspousepcbnumber: "spousePcbNumber",
  spouseidnumber: "spouseIdNumber",
  emergencycontactspouseidnumber: "spouseIdNumber",
  spouseic: "spouseIdNumber",
  spouseworking: "spouseWorking",
  spouseemployment: "spouseWorking",
  spouseemploymentstatus: "spouseWorking",
  isspouseworking: "spouseWorking",
  spousedisabled: "spouseDisabled",
  spouseoku: "spouseDisabled",
  spouseabilitystatus: "spouseDisabled",
  isspousedisabled: "spouseDisabled",
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
): Omit<AiMappingResult, "method" | "detectedChildSlots"> {
  const schema = getTargetSchemaForHeaders(sourceHeaders)
  const fieldKeys = new Set(schema.map((f) => f.key))
  const fieldKeysNormalised = new Map(
    schema.map((f) => [normaliseHeader(f.key), f.key]),
  )

  // Recognises "Dependent Child 1 - Age", "Child 2 Ability Status",
  // "child3.pcb_deduction", etc. We try this first so per-child
  // columns land on the right dynamic slot before any synonym match.
  const childHeaderPattern =
    /(?:dependent\s*child|child)[\s_\-.#]*?(\d+)[\s_\-.#:]*(age|dob|birth|ability|disabled|study|stud|school|education|pcb|deduction)/i

  function tryChildSlot(h: string): ColumnMapping | null {
    const m = h.match(childHeaderPattern)
    if (!m) return null
    const n = parseInt(m[1], 10)
    const tag = m[2].toLowerCase()
    let suffix: (typeof CHILD_SUBFIELDS)[number]["suffix"] | null = null
    if (tag.startsWith("age") || tag.startsWith("dob") || tag.startsWith("birth")) {
      suffix = "age"
    } else if (tag.startsWith("ability") || tag.startsWith("disabled")) {
      suffix = "abilityStatus"
    } else if (
      tag.startsWith("study") ||
      tag.startsWith("stud") ||
      tag.startsWith("school") ||
      tag.startsWith("education")
    ) {
      suffix = "currentlyStudying"
    } else if (tag.startsWith("pcb") || tag.startsWith("deduction")) {
      suffix = "pcbDeduction"
    }
    if (suffix == null) return null
    const target = `child${n}.${suffix}`
    if (!fieldKeys.has(target)) return null
    return {
      sourceColumn: h,
      ourField: target,
      confidence: "high",
      reason: `Recognised dependent-child slot ${n} (${suffix}).`,
    }
  }

  const mappings: ColumnMapping[] = sourceHeaders.map((h) => {
    // 0. Dynamic dependent-child slot.
    const childHit = tryChildSlot(h)
    if (childHit) return childHit

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
    if (synonym && fieldKeys.has(synonym)) {
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
      .filter(
        (k) =>
          normalised.includes(k) &&
          k.length >= 3 &&
          fieldKeys.has(HEURISTIC_SYNONYMS[k]),
      )
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
    for (const f of schema) {
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
  for (const f of schema) {
    if (f.required && !mappedTargets.has(f.key)) {
      warnings.push(`Required field "${f.key}" not matched to any source column.`)
    }
  }
  return { mappings, warnings }
}
