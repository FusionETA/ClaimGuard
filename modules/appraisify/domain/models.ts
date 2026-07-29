/**
 * Appraisify domain — pure types + helper functions. No `server-only`, no
 * Prisma imports. Mirrors the style of `modules/claims/domain/models.ts`:
 * `as const` string-literal arrays → derived union types, plus pure predicate
 * / state-machine helpers that are the single source of truth for the
 * three-phase appraisal cycle.
 */

/* ─── Enums (mirror the Prisma enums) ──────────────────────────────── */

export const appraisalStages = [
  "INITIALIZED",
  "REVIEWER_PENDING",
  "PARTNER_PENDING",
  "SUBMITTED",
] as const
export type AppraisalStage = (typeof appraisalStages)[number]

export const appraisalTypes = ["ANNUAL", "MID_YEAR", "PROBATION"] as const
export type AppraisalType = (typeof appraisalTypes)[number]

/**
 * The three phases of the cycle. Each maps to exactly one of the three people
 * on an appraisal (reviewee / reviewer / partner) and to the stage in which
 * that person can edit.
 */
export const appraisalPhases = ["reviewee", "reviewer", "partner"] as const
export type AppraisalPhase = (typeof appraisalPhases)[number]

/* ─── Stage state machine ──────────────────────────────────────────── */

/**
 * Single source of truth for advancing the cycle. Submitting a phase moves the
 * stage forward by one; `SUBMITTED` is terminal. Do not open-code these
 * transitions elsewhere.
 *
 * INITIALIZED → REVIEWER_PENDING → PARTNER_PENDING → SUBMITTED
 */
export function nextAppraisalStage(current: AppraisalStage): AppraisalStage {
  switch (current) {
    case "INITIALIZED":
      return "REVIEWER_PENDING"
    case "REVIEWER_PENDING":
      return "PARTNER_PENDING"
    case "PARTNER_PENDING":
      return "SUBMITTED"
    case "SUBMITTED":
      return "SUBMITTED"
  }
}

/** The stage during which the given phase's owner may edit their scores. */
export function editableStageFor(phase: AppraisalPhase): AppraisalStage {
  switch (phase) {
    case "reviewee":
      return "INITIALIZED"
    case "reviewer":
      return "REVIEWER_PENDING"
    case "partner":
      return "PARTNER_PENDING"
  }
}

/**
 * Gating access for a phase given the appraisal's current stage:
 *   - `editable`  — it is this phase's turn; the owner fills in scores.
 *   - `not-ready` — an earlier phase hasn't been submitted yet (amber banner).
 *   - `submitted` — this phase is already done; the owner is redirected to the
 *                   confirmation screen.
 */
export type PhaseAccess = "editable" | "not-ready" | "submitted"

export function phaseAccessFor(
  stage: AppraisalStage,
  phase: AppraisalPhase
): PhaseAccess {
  const order: Record<AppraisalStage, number> = {
    INITIALIZED: 0,
    REVIEWER_PENDING: 1,
    PARTNER_PENDING: 2,
    SUBMITTED: 3,
  }
  const phaseIndex: Record<AppraisalPhase, number> = {
    reviewee: 0,
    reviewer: 1,
    partner: 2,
  }
  const current = order[stage]
  const target = phaseIndex[phase]
  if (current < target) return "not-ready"
  if (current > target) return "submitted"
  return "editable"
}

export function isPhaseOpen(stage: AppraisalStage, phase: AppraisalPhase) {
  return phaseAccessFor(stage, phase) === "editable"
}
export function isPhaseSubmitted(stage: AppraisalStage, phase: AppraisalPhase) {
  return phaseAccessFor(stage, phase) === "submitted"
}

/**
 * Which phase (if any) the given user plays on this appraisal. Returns the
 * first matching role in reviewee → reviewer → partner order (a person should
 * only ever hold one role on a given appraisal).
 */
export function resolvePhaseForUser(
  appraisal: { reviewee: { id: string }; reviewer: { id: string }; partner: { id: string } },
  userId: string
): AppraisalPhase | null {
  if (appraisal.reviewee.id === userId) return "reviewee"
  if (appraisal.reviewer.id === userId) return "reviewer"
  if (appraisal.partner.id === userId) return "partner"
  return null
}

/** URL `?phase=` slug used by the confirmation screen. */
export function confirmPhaseParam(phase: AppraisalPhase): "self" | "reviewer" | "partner" {
  return phase === "reviewee" ? "self" : phase
}

/* ─── Labels ───────────────────────────────────────────────────────── */

export function appraisalTypeLabel(type: AppraisalType): string {
  switch (type) {
    case "ANNUAL":
      return "Annual"
    case "MID_YEAR":
      return "Mid-Year"
    case "PROBATION":
      return "Probation"
  }
}

/** e.g. "Annual Cycle 2026", "Probation Review 2026". */
export function buildCycleLabel(type: AppraisalType, year: number): string {
  return type === "PROBATION"
    ? `Probation Review ${year}`
    : `${appraisalTypeLabel(type)} Cycle ${year}`
}

export function stageLabel(stage: AppraisalStage): string {
  switch (stage) {
    case "INITIALIZED":
      return "Self-Assessment"
    case "REVIEWER_PENDING":
      return "Reviewer 1 Pending"
    case "PARTNER_PENDING":
      return "Reviewer 2 Pending"
    case "SUBMITTED":
      return "Completed"
  }
}

/**
 * Display name for a phase's role. Internally the phase/field names stay
 * `reviewer` / `partner` (matches the Prisma columns) — only the
 * user-facing label changed to "Reviewer 1" / "Reviewer 2" so the second
 * reviewer isn't confused with an unrelated "partner" role.
 */
export function phaseLabel(phase: AppraisalPhase): string {
  switch (phase) {
    case "reviewee":
      return "Self-Assessment"
    case "reviewer":
      return "Reviewer 1"
    case "partner":
      return "Reviewer 2"
  }
}

/** `APR-2026-000042` */
export function buildAppraisalReference(year: number, seq: number): string {
  return `APR-${year}-${String(seq).padStart(6, "0")}`
}

/* ─── View-models (the shapes services return to pages) ─────────────── */

export type AppraisalPersonRef = {
  id: string
  name: string
  initials: string
}

export type AppraisalQuestionView = {
  id: string
  order: number
  section: string | null
  text: string
  description: string | null
  revieweeScore: number | null
  revieweeComment: string | null
  reviewerScore: number | null
  reviewerComment: string | null
  partnerScore: number | null
  partnerComment: string | null
}

/** Per-phase free-text sections (Goals Review / Overall Remarks / Development Plans). */
export type AppraisalSectionText = {
  goals: string | null
  remarks: string | null
  development: string | null
}

/** The full record used by the appraisal form pages. */
export type AppraisalRecord = {
  id: string
  referenceNumber: string
  stage: AppraisalStage
  year: number
  type: AppraisalType
  team: string | null
  role: string | null
  reviewee: AppraisalPersonRef
  reviewer: AppraisalPersonRef
  partner: AppraisalPersonRef
  questions: AppraisalQuestionView[]
  revieweeSection: AppraisalSectionText
  reviewerSection: AppraisalSectionText
  partnerSection: AppraisalSectionText
  revieweeSubmittedAt: string | null
  reviewerSubmittedAt: string | null
  partnerSubmittedAt: string | null
  createdAt: string
  updatedAt: string
}

/** Compact row used by the dashboard "My Appraisal" overview + history list. */
export type AppraisalListItem = {
  id: string
  referenceNumber: string
  stage: AppraisalStage
  year: number
  type: AppraisalType
  cycleLabel: string
  revieweeName: string
  /** The role the current viewer plays on this appraisal. */
  viewerPhase: AppraisalPhase | null
  /** True when it is the viewer's turn to act (their phase is editable). */
  viewerCanAct: boolean
  updatedAt: string
  submittedAt: string | null
}

export type AppraisalScoreSummary = {
  self: number | null
  reviewer: number | null
  partner: number | null
}

/** Project a full record into a viewer-scoped list row. */
export function toAppraisalListItem(
  record: AppraisalRecord,
  viewerId: string,
): AppraisalListItem {
  const viewerPhase = resolvePhaseForUser(record, viewerId)
  const submittedAt =
    viewerPhase === "reviewee"
      ? record.revieweeSubmittedAt
      : viewerPhase === "reviewer"
        ? record.reviewerSubmittedAt
        : viewerPhase === "partner"
          ? record.partnerSubmittedAt
          : null
  return {
    id: record.id,
    referenceNumber: record.referenceNumber,
    stage: record.stage,
    year: record.year,
    type: record.type,
    cycleLabel: buildCycleLabel(record.type, record.year),
    revieweeName: record.reviewee.name,
    viewerPhase,
    viewerCanAct: viewerPhase ? isPhaseOpen(record.stage, viewerPhase) : false,
    updatedAt: record.updatedAt,
    submittedAt,
  }
}

/* ─── Score helpers ────────────────────────────────────────────────── */

function scoresForPhase(
  questions: AppraisalQuestionView[],
  phase: AppraisalPhase
): number[] {
  return questions
    .map((q) =>
      phase === "reviewee"
        ? q.revieweeScore
        : phase === "reviewer"
          ? q.reviewerScore
          : q.partnerScore
    )
    .filter((s): s is number => typeof s === "number")
}

/** Average of the answered scores for a phase, or null if none answered. */
export function averagePhaseScore(
  questions: AppraisalQuestionView[],
  phase: AppraisalPhase
): number | null {
  const scores = scoresForPhase(questions, phase)
  if (!scores.length) return null
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

/** How many of a phase's questions have a score entered (for the progress bar). */
export function answeredCount(
  questions: AppraisalQuestionView[],
  phase: AppraisalPhase
): number {
  return scoresForPhase(questions, phase).length
}

export function scoreSummary(
  questions: AppraisalQuestionView[]
): AppraisalScoreSummary {
  return {
    self: averagePhaseScore(questions, "reviewee"),
    reviewer: averagePhaseScore(questions, "reviewer"),
    partner: averagePhaseScore(questions, "partner"),
  }
}

/** A question's score for a given phase, or null if unanswered. */
export function scoreForPhase(
  q: AppraisalQuestionView,
  phase: AppraisalPhase
): number | null {
  switch (phase) {
    case "reviewee":
      return q.revieweeScore
    case "reviewer":
      return q.reviewerScore
    case "partner":
      return q.partnerScore
  }
}

/**
 * Group questions by section, preserving first-seen order (no section →
 * "General"). Shared by the PDF report and any read-only question listing
 * (e.g. the admin detail page) so both render sections in the same order.
 */
export function groupQuestionsBySection(
  questions: AppraisalQuestionView[]
): Array<{ section: string; questions: AppraisalQuestionView[] }> {
  const order: string[] = []
  const bySection = new Map<string, AppraisalQuestionView[]>()
  for (const q of questions) {
    const key = q.section ?? "General"
    if (!bySection.has(key)) {
      order.push(key)
      bySection.set(key, [])
    }
    bySection.get(key)!.push(q)
  }
  return order.map((section) => ({ section, questions: bySection.get(section)! }))
}

/* ─── Page-data view-models (shapes services return to pages) ──────── */

/** Employee dashboard bag. */
export type EmployeeAppraisalDashboardData = {
  viewer: AppraisalPersonRef
  current: {
    item: AppraisalListItem
    role: string | null
    team: string | null
    scores: AppraisalScoreSummary
  } | null
  history: AppraisalListItem[]
}

/** One row in the admin employees table. */
export type AdminEmployeeRow = {
  id: string
  name: string
  initials: string
  position: string
  department: string
  /** Stage of this employee's active appraisal, or null if none. */
  activeStage: AppraisalStage | null
}

/** One row in the admin appraisal-history table. */
export type AdminAppraisalHistoryRow = {
  id: string
  employeeName: string
  cycleLabel: string
  stage: AppraisalStage
  submittedAt: string | null
}

/** Admin dashboard bag. */
export type AdminAppraisalDashboardData = {
  stats: { active: number; complete: number }
  employees: AdminEmployeeRow[]
  history: AdminAppraisalHistoryRow[]
  /** Candidates for the reviewer / partner selects in the start dialog. */
  people: AppraisalPersonRef[]
  /** Question templates for the Start-Appraisal dropdown. */
  templates: AppraisalTemplateSummary[]
}

/** Data the appraisal form page passes to the form/banner/redirect. */
export type AppraisalFormData = {
  record: AppraisalRecord
  /** Which phase the viewer plays. */
  phase: AppraisalPhase
  /** Gating decision for the viewer's phase. */
  access: PhaseAccess
}

/** One employee row on the dedicated Start Appraisal page. */
export type StartAppraisalEmployee = {
  id: string
  name: string
  initials: string
  position: string
}

/** Data bag for the dedicated Start Appraisal page. */
export type StartAppraisalPageData = {
  employees: StartAppraisalEmployee[]
  people: AppraisalPersonRef[]
  templates: AppraisalTemplateSummary[]
}

/* ─── Question templates (admin-authored reusable question sets) ───── */

export type AppraisalTemplateQuestionView = {
  id: string
  order: number
  section: string | null
  text: string
  description: string | null
}

/** Full template with its questions — used by the editor. */
export type AppraisalTemplateView = {
  id: string
  name: string
  archived: boolean
  questions: AppraisalTemplateQuestionView[]
  updatedAt: string
}

/** Compact row for the templates list + the Start-Appraisal dropdown. */
export type AppraisalTemplateSummary = {
  id: string
  name: string
  questionCount: number
  updatedAt: string
}

/** One question as authored in the builder (no id — templates are replace-on-save). */
export type TemplateQuestionInput = {
  section: string | null
  text: string
  description: string | null
}

/* ─── AI Assist (chat-based question drafting + bulk template setup) ── */
//
// Both features share one wire contract with the AI: replies are free-form
// chat text that may contain tagged JSON blocks the model is instructed to
// emit. `<questions>` blocks (used by the in-builder chat + "Improve with
// AI") carry an array of suggested questions; `<template>` blocks (used by
// the bulk setup wizard) carry one full template each. Field name is `desc`
// on the wire (matches the reference app's prompt contract) — converted to
// our `description` field only at the point a suggestion is actually added
// to a draft, via `toTemplateQuestionInput`.

export type AiChatMessage = { role: "user" | "assistant"; content: string }

export type AiSuggestedQuestion = {
  section: string | null
  text: string
  desc: string | null
}

export type AiGeneratedTemplate = {
  name: string
  questions: AiSuggestedQuestion[]
}

function coerceAiSuggestedQuestion(raw: unknown): AiSuggestedQuestion | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const text = typeof r.text === "string" ? r.text.trim() : ""
  if (!text) return null
  return {
    section: typeof r.section === "string" && r.section.trim() ? r.section.trim() : null,
    text,
    desc: typeof r.desc === "string" && r.desc.trim() ? r.desc.trim() : null,
  }
}

/**
 * Parses `<questions>[...]</questions>` blocks out of a raw assistant reply.
 * A malformed individual block is skipped rather than failing the whole
 * parse — the model occasionally emits a truncated or invalid block
 * alongside otherwise-good ones. `cleanedText` is the reply with every
 * `<questions>` block removed, for rendering as plain chat text.
 */
export function parseAiQuestionBlocks(raw: string): {
  questions: AiSuggestedQuestion[]
  cleanedText: string
} {
  const questions: AiSuggestedQuestion[] = []
  const regex = /<questions>([\s\S]*?)<\/questions>/g
  const cleanedText = raw
    .replace(regex, (_match, body: string) => {
      try {
        const parsed = JSON.parse(body.trim())
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const q = coerceAiSuggestedQuestion(item)
            if (q) questions.push(q)
          }
        }
      } catch {
        // Malformed JSON in a <questions> block — drop it, keep the rest.
      }
      return ""
    })
    .trim()
  return { questions, cleanedText }
}

/**
 * Parses `<template>{...}</template>` blocks — each a full flat
 * `{name, questions:[{section,text,desc}]}` object (NOT the nested
 * scope/engagement shape some reference apps use; our data model has no
 * such split, so the AI is prompted to never produce it).
 */
export function parseAiTemplateBlocks(raw: string): {
  templates: AiGeneratedTemplate[]
  cleanedText: string
} {
  const templates: AiGeneratedTemplate[] = []
  const regex = /<template>([\s\S]*?)<\/template>/g
  const cleanedText = raw
    .replace(regex, (_match, body: string) => {
      try {
        const parsed = JSON.parse(body.trim()) as Record<string, unknown>
        const name = typeof parsed.name === "string" ? parsed.name.trim() : ""
        const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : []
        const questions = rawQuestions
          .map((q) => coerceAiSuggestedQuestion(q))
          .filter((q): q is AiSuggestedQuestion => q !== null)
        if (name && questions.length > 0) {
          templates.push({ name, questions })
        }
      } catch {
        // Malformed JSON in a <template> block — drop it, keep the rest.
      }
      return ""
    })
    .trim()
  return { templates, cleanedText }
}

/** AI wire format (`desc`) → our persisted field (`description`). */
export function toTemplateQuestionInput(q: AiSuggestedQuestion): TemplateQuestionInput {
  return { section: q.section, text: q.text, description: q.desc }
}

/**
 * Minimal safe markdown for chat bubbles: HTML-escape first (so a message
 * can't inject markup), then apply `**bold**` and newlines. Escaping before
 * substitution avoids double-escaping the tags we just inserted.
 */
export function renderChatMarkup(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>")
}

/**
 * Group AI-generated question suggestions by section, preserving
 * first-seen order (no section → "General"). Same shape as
 * `groupQuestionsBySection` but for `AiSuggestedQuestion[]` — that
 * helper's input type carries per-phase scores that don't apply here,
 * so this is a separate small helper rather than a forced reuse.
 */
export function groupAiQuestionsBySection(
  questions: AiSuggestedQuestion[]
): Array<{ section: string; questions: AiSuggestedQuestion[] }> {
  const order: string[] = []
  const bySection = new Map<string, AiSuggestedQuestion[]>()
  for (const q of questions) {
    const key = q.section ?? "General"
    if (!bySection.has(key)) {
      order.push(key)
      bySection.set(key, [])
    }
    bySection.get(key)!.push(q)
  }
  return order.map((section) => ({ section, questions: bySection.get(section)! }))
}

/* ─── Seeded default question set ──────────────────────────────────── */

export type DefaultAppraisalQuestion = {
  order: number
  section: string
  text: string
  description?: string
}

/**
 * The default question set snapshotted onto each appraisal at creation time
 * (v1 has no admin question-builder). Grouped into sections that drive the
 * section-tab filter in the form UI.
 */
export const DEFAULT_APPRAISAL_QUESTIONS: ReadonlyArray<DefaultAppraisalQuestion> = [
  // Technical Skills
  { order: 1, section: "Technical Skills", text: "Code quality and adherence to best practices", description: "Writes clean, maintainable, well-tested code." },
  { order: 2, section: "Technical Skills", text: "Problem-solving and debugging ability", description: "Diagnoses issues methodically and resolves them efficiently." },
  { order: 3, section: "Technical Skills", text: "System design and architectural thinking", description: "Designs solutions that are scalable and appropriate to the problem." },
  { order: 4, section: "Technical Skills", text: "Depth of domain and product knowledge" },
  // Collaboration
  { order: 5, section: "Collaboration", text: "Teamwork and communication effectiveness", description: "Communicates clearly and works well across the team." },
  { order: 6, section: "Collaboration", text: "Knowledge sharing and mentoring" },
  { order: 7, section: "Collaboration", text: "Cross-team collaboration and managing dependencies" },
  { order: 8, section: "Collaboration", text: "Openness to feedback and continuous improvement" },
  // Delivery
  { order: 9, section: "Delivery", text: "Meeting deadlines and commitments", description: "Delivers agreed work on time and flags risks early." },
  { order: 10, section: "Delivery", text: "Scope management and prioritisation" },
  { order: 11, section: "Delivery", text: "Quality of deliverables and documentation" },
  { order: 12, section: "Delivery", text: "Ownership and accountability for outcomes" },
  // Leadership & Growth
  { order: 13, section: "Leadership & Growth", text: "Initiative and proactiveness" },
  { order: 14, section: "Leadership & Growth", text: "Adaptability to change and ambiguity" },
  { order: 15, section: "Leadership & Growth", text: "Alignment with company values and culture" },
  { order: 16, section: "Leadership & Growth", text: "Progress against previous development goals" },
]
