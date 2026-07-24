/**
 * Seed sample Appraisify records AND exercise the full data round-trip
 * (create → submit each phase → assert stage transitions + persistence).
 * Additive only — it creates new appraisals each run; never deletes.
 *
 * Uses raw Prisma (the script convention here — the repository imports
 * `server-only`, which Next only provides at build time) plus the pure
 * domain helpers, so the same DB operations and state machine are verified.
 *
 * Run: npm run db:seed-appraisals
 */
import "dotenv/config"

import { getPrismaClient } from "../lib/prisma"
import {
  DEFAULT_APPRAISAL_QUESTIONS,
  buildAppraisalReference,
  nextAppraisalStage,
  phaseAccessFor,
  type AppraisalPhase,
  type AppraisalStage,
} from "../modules/appraisify/domain/models"

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

const questionCreate = DEFAULT_APPRAISAL_QUESTIONS.map((q) => ({
  order: q.order,
  section: q.section,
  text: q.text,
  description: q.description ?? null,
}))

type Q = { id: string; score: number; comment: string }

function phaseSectionData(phase: AppraisalPhase, now: Date) {
  if (phase === "reviewee")
    return { revieweeGoals: "goals", revieweeRemarks: "remarks", revieweeDevelopment: "dev", revieweeSubmittedAt: now }
  if (phase === "reviewer")
    return { reviewerGoals: "goals", reviewerRemarks: "remarks", reviewerDevelopment: "dev", reviewerSubmittedAt: now }
  return { partnerGoals: "goals", partnerRemarks: "remarks", partnerDevelopment: "dev", partnerSubmittedAt: now }
}
function phaseQuestionData(phase: AppraisalPhase, score: number, comment: string) {
  if (phase === "reviewee") return { revieweeScore: score, revieweeComment: comment }
  if (phase === "reviewer") return { reviewerScore: score, reviewerComment: comment }
  return { partnerScore: score, partnerComment: comment }
}

async function main() {
  const client = getPrismaClient()
  if (!client) throw new Error("Database is not configured")
  // Bind to a non-null const so the narrowing survives inside the closure below.
  const prisma = client

  async function submitPhase(id: string, current: AppraisalStage, phase: AppraisalPhase, qs: Q[]) {
    const next = nextAppraisalStage(current)
    const now = new Date()
    await prisma.$transaction([
      prisma.appraisal.update({ where: { id }, data: { stage: next, ...phaseSectionData(phase, now) } }),
      ...qs.map((q) =>
        prisma.appraisalQuestion.update({ where: { id: q.id }, data: phaseQuestionData(phase, q.score, q.comment) }),
      ),
    ])
    return next
  }

  const org = await prisma.organization.findFirst({
    orderBy: { users: { _count: "desc" } },
    select: { id: true, name: true },
  })
  if (!org) throw new Error("No organizations found")

  const people = await prisma.user.findMany({
    where: { organizationId: org.id },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })
  if (people.length < 3) throw new Error(`Org "${org.name}" needs ≥3 users (has ${people.length})`)
  const [reviewer, partner, ...reviewees] = people
  console.log(`\nOrg: ${org.name} (${org.id})`)
  console.log(`Reviewer: ${reviewer!.name} · Partner: ${partner!.name}`)

  const year = new Date().getFullYear()
  const base = await prisma.appraisal.count()

  const include = { questions: { orderBy: { order: "asc" as const } } }

  // ── 1) Full-cycle round-trip ─────────────────────────────────────────
  console.log(`\n[1] Full-cycle round-trip:`)
  const rt = await prisma.appraisal.create({
    data: {
      organizationId: org.id,
      referenceNumber: buildAppraisalReference(year, base + 1),
      year,
      type: "ANNUAL",
      team: "Engineering",
      role: "Software Engineer",
      revieweeId: reviewees[0]!.id,
      reviewerId: reviewer!.id,
      partnerId: partner!.id,
      createdByUserId: reviewer!.id,
      questions: { create: questionCreate },
    },
    include,
  })
  assert(rt.stage === "INITIALIZED", "new appraisal starts at INITIALIZED")
  assert(rt.questions.length === questionCreate.length, `snapshotted ${questionCreate.length} questions`)
  assert(phaseAccessFor(rt.stage, "reviewee") === "editable", "reviewee phase open at INITIALIZED")
  assert(phaseAccessFor(rt.stage, "reviewer") === "not-ready", "reviewer not-ready at INITIALIZED")

  const qs = (): Q[] => rt.questions.map((q, i) => ({ id: q.id, score: 3 + (i % 3) * 0.5, comment: "note" }))
  let stage: AppraisalStage = rt.stage as AppraisalStage
  stage = (await submitPhase(rt.id, stage, "reviewee", qs())) as AppraisalStage
  assert(stage === "REVIEWER_PENDING", "reviewee submit → REVIEWER_PENDING")
  stage = (await submitPhase(rt.id, stage, "reviewer", qs())) as AppraisalStage
  assert(stage === "PARTNER_PENDING", "reviewer submit → PARTNER_PENDING")
  stage = (await submitPhase(rt.id, stage, "partner", qs())) as AppraisalStage
  assert(stage === "SUBMITTED", "partner submit → SUBMITTED")

  const done = await prisma.appraisal.findUnique({ where: { id: rt.id }, include })
  assert(done!.stage === "SUBMITTED", "reloads as SUBMITTED")
  assert(!!done!.revieweeSubmittedAt && !!done!.reviewerSubmittedAt && !!done!.partnerSubmittedAt, "all three submittedAt stamped")
  assert(
    done!.questions.every((q) => q.revieweeScore != null && q.reviewerScore != null && q.partnerScore != null),
    "all phase scores persisted",
  )

  // ── 2) Persistent samples at earlier stages ──────────────────────────
  console.log(`\n[2] Sample cycles for the dashboard:`)
  if (reviewees[1]) {
    const a = await prisma.appraisal.create({
      data: {
        organizationId: org.id, referenceNumber: buildAppraisalReference(year, base + 2), year, type: "ANNUAL",
        team: "Engineering", role: "Analyst", revieweeId: reviewees[1].id, reviewerId: reviewer!.id,
        partnerId: partner!.id, createdByUserId: reviewer!.id, questions: { create: questionCreate },
      },
    })
    console.log(`  • ${a.referenceNumber} — ${reviewees[1].name} (INITIALIZED / self-assessment due)`)
  }
  if (reviewees[2]) {
    const b = await prisma.appraisal.create({
      data: {
        organizationId: org.id, referenceNumber: buildAppraisalReference(year, base + 3), year, type: "MID_YEAR",
        team: "Product", role: "Designer", revieweeId: reviewees[2].id, reviewerId: reviewer!.id,
        partnerId: partner!.id, createdByUserId: reviewer!.id, questions: { create: questionCreate },
      },
      include,
    })
    await submitPhase(b.id, "INITIALIZED", "reviewee", b.questions.map((q, i) => ({ id: q.id, score: 4 + (i % 2) * 0.5, comment: "self" })))
    console.log(`  • ${b.referenceNumber} — ${reviewees[2].name} (REVIEWER_PENDING)`)
  }

  console.log(`\n✅ Done. Completed-cycle reviewee: ${reviewees[0]!.name}`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
