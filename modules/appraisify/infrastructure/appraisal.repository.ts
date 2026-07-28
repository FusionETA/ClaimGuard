import "server-only"

import { toNumber } from "@/lib/decimal"
import { getPrismaClient } from "@/lib/prisma"
import { buildInitials } from "@/lib/utils"

import type { Prisma } from "@/generated/prisma/client"
import {
  nextAppraisalStage,
  type AppraisalPhase,
  type AppraisalPersonRef,
  type AppraisalQuestionView,
  type AppraisalRecord,
  type AppraisalStage,
  type AppraisalType,
} from "@/modules/appraisify/domain/models"

/**
 * Module-scoped Prisma accessor. All Appraisify DB access flows through this
 * repository (services never touch Prisma directly).
 */
function getAppraisalsPrismaClient() {
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured")
  return prisma
}

/* ── selection shapes + mappers ────────────────────────────────────── */

const personSelect = { select: { id: true, name: true } }

const appraisalInclude = {
  reviewee: personSelect,
  reviewer: personSelect,
  partner: personSelect,
  questions: { orderBy: { order: "asc" } },
} satisfies Prisma.AppraisalInclude

type PrismaAppraisalWithRelations = Prisma.AppraisalGetPayload<{
  include: typeof appraisalInclude
}>
type PrismaQuestion = PrismaAppraisalWithRelations["questions"][number]

/** Coerce a nullable Prisma Decimal to `number | null`. */
function decOrNull(value: unknown): number | null {
  return toNumber(value) ?? null
}

function mapPerson(p: { id: string; name: string }): AppraisalPersonRef {
  return { id: p.id, name: p.name, initials: buildInitials(p.name) }
}

function mapQuestion(q: PrismaQuestion): AppraisalQuestionView {
  return {
    id: q.id,
    order: q.order,
    section: q.section,
    text: q.text,
    description: q.description,
    revieweeScore: decOrNull(q.revieweeScore),
    revieweeComment: q.revieweeComment,
    reviewerScore: decOrNull(q.reviewerScore),
    reviewerComment: q.reviewerComment,
    partnerScore: decOrNull(q.partnerScore),
    partnerComment: q.partnerComment,
  }
}

function mapAppraisal(a: PrismaAppraisalWithRelations): AppraisalRecord {
  return {
    id: a.id,
    referenceNumber: a.referenceNumber,
    stage: a.stage as AppraisalStage,
    year: a.year,
    type: a.type as AppraisalType,
    team: a.team,
    role: a.role,
    reviewee: mapPerson(a.reviewee),
    reviewer: mapPerson(a.reviewer),
    partner: mapPerson(a.partner),
    questions: a.questions.map(mapQuestion),
    revieweeSection: { goals: a.revieweeGoals, remarks: a.revieweeRemarks, development: a.revieweeDevelopment },
    reviewerSection: { goals: a.reviewerGoals, remarks: a.reviewerRemarks, development: a.reviewerDevelopment },
    partnerSection: { goals: a.partnerGoals, remarks: a.partnerRemarks, development: a.partnerDevelopment },
    revieweeSubmittedAt: a.revieweeSubmittedAt?.toISOString() ?? null,
    reviewerSubmittedAt: a.reviewerSubmittedAt?.toISOString() ?? null,
    partnerSubmittedAt: a.partnerSubmittedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }
}

/* ── write-input shapes ────────────────────────────────────────────── */

export type CreateAppraisalInput = {
  orgId: string
  createdByUserId: string
  revieweeId: string
  reviewerId: string
  partnerId: string
  year: number
  type: AppraisalType
  team: string | null
  role: string | null
  referenceNumber: string
  questions: Array<{ order: number; section: string | null; text: string; description: string | null }>
}

export type PhaseWriteInput = {
  appraisalId: string
  orgId: string
  phase: AppraisalPhase
  /** Whether to advance the stage + stamp the submitted-at timestamp. */
  submit: boolean
  questions: Array<{ id: string; score: number | null; comment: string | null }>
  section: { goals: string | null; remarks: string | null; development: string | null }
}

/** Build the phase-specific column payload for the Appraisal row. */
function appraisalPhaseData(
  input: PhaseWriteInput,
  now: Date | null,
): Prisma.AppraisalUpdateInput {
  const { phase, section } = input
  if (phase === "reviewee") {
    return {
      revieweeGoals: section.goals,
      revieweeRemarks: section.remarks,
      revieweeDevelopment: section.development,
      ...(now ? { revieweeSubmittedAt: now } : {}),
    }
  }
  if (phase === "reviewer") {
    return {
      reviewerGoals: section.goals,
      reviewerRemarks: section.remarks,
      reviewerDevelopment: section.development,
      ...(now ? { reviewerSubmittedAt: now } : {}),
    }
  }
  return {
    partnerGoals: section.goals,
    partnerRemarks: section.remarks,
    partnerDevelopment: section.development,
    ...(now ? { partnerSubmittedAt: now } : {}),
  }
}

/** Build the phase-specific column payload for an AppraisalQuestion row. */
function questionPhaseData(
  phase: AppraisalPhase,
  score: number | null,
  comment: string | null,
): Prisma.AppraisalQuestionUpdateInput {
  if (phase === "reviewee") return { revieweeScore: score, revieweeComment: comment }
  if (phase === "reviewer") return { reviewerScore: score, reviewerComment: comment }
  return { partnerScore: score, partnerComment: comment }
}

/* ── repository ────────────────────────────────────────────────────── */

export const appraisalRepository = {
  /** All appraisals where the user is reviewee, reviewer, or partner. */
  async listForUser(userId: string, orgId: string): Promise<AppraisalRecord[]> {
    const prisma = getAppraisalsPrismaClient()
    const rows = await prisma.appraisal.findMany({
      where: {
        organizationId: orgId,
        OR: [{ revieweeId: userId }, { reviewerId: userId }, { partnerId: userId }],
      },
      include: appraisalInclude,
      orderBy: { updatedAt: "desc" },
    })
    return rows.map(mapAppraisal)
  },

  /**
   * Count-only version of "how many appraisals need this user's action right
   * now" — i.e. rows where the user holds the role whose phase is currently
   * open. Does not hydrate questions/records; used for the nav badge.
   */
  async countPendingForUser(userId: string, orgId: string): Promise<number> {
    const prisma = getAppraisalsPrismaClient()
    return prisma.appraisal.count({
      where: {
        organizationId: orgId,
        OR: [
          { revieweeId: userId, stage: "INITIALIZED" },
          { reviewerId: userId, stage: "REVIEWER_PENDING" },
          { partnerId: userId, stage: "PARTNER_PENDING" },
        ],
      },
    })
  },

  async getByIdForOrg(id: string, orgId: string): Promise<AppraisalRecord | null> {
    const prisma = getAppraisalsPrismaClient()
    const row = await prisma.appraisal.findFirst({
      where: { id, organizationId: orgId },
      include: appraisalInclude,
    })
    return row ? mapAppraisal(row) : null
  },

  /** Total appraisal count — used to seed reference-number sequences. */
  async countAll(): Promise<number> {
    const prisma = getAppraisalsPrismaClient()
    return prisma.appraisal.count()
  },

  async createAppraisal(input: CreateAppraisalInput): Promise<AppraisalRecord> {
    const prisma = getAppraisalsPrismaClient()
    const row = await prisma.appraisal.create({
      data: {
        organizationId: input.orgId,
        referenceNumber: input.referenceNumber,
        year: input.year,
        type: input.type,
        team: input.team,
        role: input.role,
        revieweeId: input.revieweeId,
        reviewerId: input.reviewerId,
        partnerId: input.partnerId,
        createdByUserId: input.createdByUserId,
        questions: {
          create: input.questions.map((q) => ({
            order: q.order,
            section: q.section,
            text: q.text,
            description: q.description,
          })),
        },
      },
      include: appraisalInclude,
    })
    return mapAppraisal(row)
  },

  /**
   * Persist a phase's scores/comments/section text. When `submit` is true,
   * advance the stage (via `nextAppraisalStage`) and stamp the phase's
   * submitted-at. Returns the new stage, or null if the appraisal is missing.
   */
  async writePhase(input: PhaseWriteInput): Promise<AppraisalStage | null> {
    const prisma = getAppraisalsPrismaClient()
    const current = await prisma.appraisal.findFirst({
      where: { id: input.appraisalId, organizationId: input.orgId },
      select: { stage: true },
    })
    if (!current) return null

    const now = input.submit ? new Date() : null
    const nextStage = input.submit
      ? nextAppraisalStage(current.stage as AppraisalStage)
      : (current.stage as AppraisalStage)

    // The batch (array) `$transaction` form's options only accept
    // `isolationLevel` on this Prisma version — no `timeout` — so a custom
    // timeout requires the interactive (callback) form instead. One round
    // trip per question (up to 16 in the default set) plus the appraisal
    // update itself easily clears Prisma's 5000ms default on anything but
    // a same-host DB, so a submit with the full default question set was
    // failing on normal latency.
    await prisma.$transaction(
      async (tx) => {
        await tx.appraisal.update({
          where: { id: input.appraisalId },
          data: {
            ...appraisalPhaseData(input, now),
            ...(input.submit ? { stage: nextStage } : {}),
          },
        })
        for (const q of input.questions) {
          await tx.appraisalQuestion.update({
            where: { id: q.id },
            data: questionPhaseData(input.phase, q.score, q.comment),
          })
        }
      },
      { timeout: 20_000 },
    )
    return nextStage
  },

  /* ── admin queries ───────────────────────────────────────────────── */

  /** All appraisals for an org (admin history + per-employee active stage). */
  async listForOrg(orgId: string): Promise<AppraisalRecord[]> {
    const prisma = getAppraisalsPrismaClient()
    const rows = await prisma.appraisal.findMany({
      where: { organizationId: orgId },
      include: appraisalInclude,
      orderBy: { updatedAt: "desc" },
    })
    return rows.map(mapAppraisal)
  },

  /** Employees of the org: user id + name + job title (position). */
  async listOrgEmployees(
    orgId: string,
  ): Promise<Array<{ userId: string; name: string; jobTitle: string }>> {
    const prisma = getAppraisalsPrismaClient()
    const rows = await prisma.employeeProfile.findMany({
      where: { organizationId: orgId },
      select: { userId: true, jobTitle: true, user: { select: { name: true } } },
      orderBy: { user: { name: "asc" } },
    })
    return rows.map((r) => ({ userId: r.userId, name: r.user.name, jobTitle: r.jobTitle }))
  },

  /** All users in the org — reviewer / partner candidates for new cycles. */
  async listOrgPeople(orgId: string): Promise<AppraisalPersonRef[]> {
    const prisma = getAppraisalsPrismaClient()
    const rows = await prisma.user.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    })
    return rows.map(mapPerson)
  },
}
