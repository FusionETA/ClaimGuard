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
      return "Reviewer Pending"
    case "PARTNER_PENDING":
      return "Partner Pending"
    case "SUBMITTED":
      return "Completed"
  }
}

export function phaseLabel(phase: AppraisalPhase): string {
  switch (phase) {
    case "reviewee":
      return "Self-Assessment"
    case "reviewer":
      return "Reviewer"
    case "partner":
      return "Partner"
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
}

/** Data the appraisal form page passes to the form/banner/redirect. */
export type AppraisalFormData = {
  record: AppraisalRecord
  /** Which phase the viewer plays. */
  phase: AppraisalPhase
  /** Gating decision for the viewer's phase. */
  access: PhaseAccess
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
