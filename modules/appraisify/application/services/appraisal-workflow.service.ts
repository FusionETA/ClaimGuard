import "server-only"

import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import {
  appraisalRepository,
  type CreateAppraisalInput,
} from "@/modules/appraisify/infrastructure/appraisal.repository"
import {
  DEFAULT_APPRAISAL_QUESTIONS,
  buildAppraisalReference,
  phaseAccessFor,
  resolvePhaseForUser,
  type AppraisalStage,
} from "@/modules/appraisify/domain/models"

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

export const createAppraisalsSchema = z
  .object({
    employeeIds: z.array(z.string().min(1)).min(1, "Select at least one employee."),
    reviewerId: z.string().min(1, "Choose a reviewer."),
    partnerId: z.string().min(1, "Choose a partner."),
    year: z.number().int().min(2000).max(2100),
    type: z.enum(["ANNUAL", "MID_YEAR", "PROBATION"]),
  })
  .refine((d) => d.reviewerId !== d.partnerId, {
    message: "Reviewer and partner must be different people.",
    path: ["partnerId"],
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

  return { ok: true, nextStage, submitted: data.submit }
}

/* ── Admin create ──────────────────────────────────────────────────── */

/**
 * Create appraisal cycles for the selected employees, assigning the same
 * reviewer + partner and snapshotting the default question set. Employees who
 * would review themselves (reviewer/partner === reviewee) are skipped.
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

  const targets = data.employeeIds.filter(
    (id) => id !== data.reviewerId && id !== data.partnerId,
  )
  if (targets.length === 0) {
    return { ok: false, message: "An employee cannot be their own reviewer or partner." }
  }

  const base = await appraisalRepository.countAll()

  let created = 0
  for (let i = 0; i < targets.length; i++) {
    const revieweeId = targets[i]!
    const ref = buildAppraisalReference(data.year, base + 1 + i)
    const payload: CreateAppraisalInput = {
      orgId,
      createdByUserId: session.userId,
      revieweeId,
      reviewerId: data.reviewerId,
      partnerId: data.partnerId,
      year: data.year,
      type: data.type,
      team: null,
      role: jobTitleByUser.get(revieweeId) ?? null,
      referenceNumber: ref,
      questions: DEFAULT_APPRAISAL_QUESTIONS.map((q) => ({
        order: q.order,
        section: q.section,
        text: q.text,
        description: q.description ?? null,
      })),
    }
    await appraisalRepository.createAppraisal(payload)
    created++
  }

  return { ok: true, count: created }
}
