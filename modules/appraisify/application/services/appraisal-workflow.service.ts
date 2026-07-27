import "server-only"

import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { notify } from "@/modules/notifications/application/services/notification.service"
import {
  appraisalRepository,
  type CreateAppraisalInput,
} from "@/modules/appraisify/infrastructure/appraisal.repository"
import { appraisalTemplateRepository } from "@/modules/appraisify/infrastructure/appraisal-template.repository"
import {
  DEFAULT_APPRAISAL_QUESTIONS,
  buildAppraisalReference,
  buildCycleLabel,
  phaseAccessFor,
  resolvePhaseForUser,
  type AppraisalPhase,
  type AppraisalRecord,
  type AppraisalStage,
} from "@/modules/appraisify/domain/models"

/**
 * Notify the person whose turn it now is (or the reviewee, on completion).
 * Best-effort — mirrors the claims module's pattern: notifications must
 * never block or fail a successful submission.
 */
async function notifyNextActor(
  record: AppraisalRecord,
  orgId: string,
  submittedPhase: AppraisalPhase,
  actorName: string,
): Promise<void> {
  try {
    const cycle = buildCycleLabel(record.type, record.year)
    if (submittedPhase === "reviewee") {
      await notify({
        userId: record.reviewer.id,
        organizationId: orgId,
        type: "APPRAISAL_PHASE_READY",
        title: "Appraisal Ready for Review",
        body: `${actorName} submitted their self-assessment for ${cycle}. It's ready for your review.`,
        url: `/employee/appraisals/${record.id}`,
      })
    } else if (submittedPhase === "reviewer") {
      await notify({
        userId: record.partner.id,
        organizationId: orgId,
        type: "APPRAISAL_PHASE_READY",
        title: "Appraisal Ready for Reviewer 2",
        body: `${actorName} completed their review of ${record.reviewee.name}'s ${cycle}. It's ready for your review.`,
        url: `/employee/appraisals/${record.id}`,
      })
    } else {
      await notify({
        userId: record.reviewee.id,
        organizationId: orgId,
        type: "APPRAISAL_COMPLETED",
        title: "Appraisal Completed",
        body: `Your ${cycle} appraisal is complete. The final summary is now available.`,
        url: "/employee/appraisals",
      })
    }
  } catch {
    // Notifications are best-effort — never block a successful submission.
  }
}

/* ── Zod schemas (shared by client preview + server action) ────────── */

export const appraisalPhaseEnum = z.enum(["reviewee", "reviewer", "partner"])

const questionAnswerSchema = z.object({
  questionId: z.string().min(1),
  score: z.number().min(1).max(5).nullable(),
  comment: z.string().max(5000).nullable(),
})

const sectionSchema = z.object({
  goals: z.string().max(10000).nullable(),
  remarks: z.string().max(10000).nullable(),
  development: z.string().max(10000).nullable(),
})

export const submitPhaseSchema = z.object({
  appraisalId: z.string().min(1),
  phase: appraisalPhaseEnum,
  submit: z.boolean(),
  questions: z.array(questionAnswerSchema),
  section: sectionSchema,
})
export type SubmitPhaseInput = z.infer<typeof submitPhaseSchema>

/**
 * One employee's reviewer assignment. Each employee gets their own
 * Reviewer 1 / Reviewer 2 pair — there is no single reviewer/partner
 * applied to the whole batch.
 */
export const appraisalAssignmentSchema = z
  .object({
    employeeId: z.string().min(1),
    reviewerId: z.string().min(1, "Assign Reviewer 1."),
    partnerId: z.string().min(1, "Assign Reviewer 2."),
  })
  .refine((a) => a.reviewerId !== a.partnerId, {
    message: "Reviewer 1 and Reviewer 2 must be different people.",
    path: ["partnerId"],
  })
  .refine((a) => a.employeeId !== a.reviewerId, {
    message: "An employee cannot be their own Reviewer 1.",
    path: ["reviewerId"],
  })
  .refine((a) => a.employeeId !== a.partnerId, {
    message: "An employee cannot be their own Reviewer 2.",
    path: ["partnerId"],
  })
export type AppraisalAssignmentInput = z.infer<typeof appraisalAssignmentSchema>

export const createAppraisalsSchema = z.object({
  assignments: z.array(appraisalAssignmentSchema).min(1, "Select at least one employee."),
  year: z.number().int().min(2000).max(2100),
  type: z.enum(["ANNUAL", "MID_YEAR", "PROBATION"]),
  /** Optional question template; falls back to the default set when absent. */
  templateId: z.string().min(1).optional().nullable(),
})
export type CreateAppraisalsInput = z.infer<typeof createAppraisalsSchema>

/* ── Result unions ─────────────────────────────────────────────────── */

type SubmitResult =
  | { ok: true; nextStage: AppraisalStage; submitted: boolean }
  | { ok: false; message: string }

type CreateResult =
  | { ok: true; count: number }
  | { ok: false; message: string }

/* ── Phase submit / draft ──────────────────────────────────────────── */

/**
 * Persist a phase's answers. Re-validates input, then enforces gating: the
 * caller must be the assigned owner of `input.phase` and that phase must be
 * open at the record's current stage. On `submit`, the stage advances.
 */
export async function submitAppraisalPhase(input: unknown): Promise<SubmitResult> {
  const session = await getCurrentSession()
  if (!session) return { ok: false, message: "Not signed in." }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, message: "No active organization." }

  const parsed = submitPhaseSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: "Invalid submission." }
  const data = parsed.data

  const record = await appraisalRepository.getByIdForOrg(data.appraisalId, orgId)
  if (!record) return { ok: false, message: "Appraisal not found." }

  // Gating: viewer must own this phase, and the phase must be the open one.
  const viewerPhase = resolvePhaseForUser(record, session.userId)
  if (viewerPhase !== data.phase) {
    return { ok: false, message: "You are not assigned to this phase." }
  }
  if (phaseAccessFor(record.stage, data.phase) !== "editable") {
    return { ok: false, message: "This phase is not open for editing." }
  }

  // On final submit, every question must be scored 1–5.
  if (data.submit) {
    const answered = new Map(data.questions.map((q) => [q.questionId, q.score]))
    const missing = record.questions.some((q) => {
      const s = answered.get(q.id)
      return s == null
    })
    if (missing) return { ok: false, message: "Please score every question before submitting." }
  }

  const nextStage = await appraisalRepository.writePhase({
    appraisalId: data.appraisalId,
    orgId,
    phase: data.phase,
    submit: data.submit,
    questions: data.questions.map((q) => ({ id: q.questionId, score: q.score, comment: q.comment })),
    section: data.section,
  })
  if (!nextStage) return { ok: false, message: "Appraisal not found." }

  // Only a real submit (not a draft save) advances the cycle — notify
  // whoever's turn it is next.
  if (data.submit) {
    await notifyNextActor(record, orgId, data.phase, session.name)
  }

  return { ok: true, nextStage, submitted: data.submit }
}

/* ── Admin create ──────────────────────────────────────────────────── */

/**
 * Create appraisal cycles for the given per-employee assignments (each
 * employee gets their own Reviewer 1 / Reviewer 2), snapshotting the chosen
 * question set onto every created record. Self-review is rejected per
 * assignment by the Zod schema, not filtered out silently.
 */
export async function createAppraisalsForEmployees(input: unknown): Promise<CreateResult> {
  const session = await getCurrentSession()
  if (!session) return { ok: false, message: "Not signed in." }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, message: "No active organization." }

  const parsed = createAppraisalsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input." }
  }
  const data = parsed.data

  // Role snapshot per employee (job title).
  const employees = await appraisalRepository.listOrgEmployees(orgId)
  const jobTitleByUser = new Map(employees.map((e) => [e.userId, e.jobTitle]))

  // Resolve the question set to snapshot: the chosen template, else the
  // built-in default. Snapshotting means later template edits don't touch
  // appraisals already created.
  let questionSet: Array<{ order: number; section: string | null; text: string; description: string | null }>
  if (data.templateId) {
    const tq = await appraisalTemplateRepository.getQuestionsForSnapshot(data.templateId, orgId)
    if (!tq) return { ok: false, message: "Template not found." }
    if (tq.length === 0) return { ok: false, message: "The selected template has no questions." }
    questionSet = tq
  } else {
    questionSet = DEFAULT_APPRAISAL_QUESTIONS.map((q) => ({
      order: q.order,
      section: q.section,
      text: q.text,
      description: q.description ?? null,
    }))
  }

  const base = await appraisalRepository.countAll()

  let createdCount = 0
  for (let i = 0; i < data.assignments.length; i++) {
    const assignment = data.assignments[i]!
    const ref = buildAppraisalReference(data.year, base + 1 + i)
    const payload: CreateAppraisalInput = {
      orgId,
      createdByUserId: session.userId,
      revieweeId: assignment.employeeId,
      reviewerId: assignment.reviewerId,
      partnerId: assignment.partnerId,
      year: data.year,
      type: data.type,
      team: null,
      role: jobTitleByUser.get(assignment.employeeId) ?? null,
      referenceNumber: ref,
      questions: questionSet,
    }
    const createdRecord = await appraisalRepository.createAppraisal(payload)
    createdCount++

    try {
      await notify({
        userId: assignment.employeeId,
        organizationId: orgId,
        type: "APPRAISAL_PHASE_READY",
        title: "Appraisal Cycle Started",
        body: `Your ${buildCycleLabel(data.type, data.year)} performance appraisal has started. Complete your self-assessment when ready.`,
        url: `/employee/appraisals/${createdRecord.id}`,
      })
    } catch {
      // Notifications are best-effort — never block a successful create.
    }
  }

  return { ok: true, count: createdCount }
}
