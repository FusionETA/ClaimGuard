import "server-only"

import { getPrismaClient } from "@/lib/prisma"

import type { Prisma } from "@/generated/prisma/client"
import type {
  AppraisalTemplateSummary,
  AppraisalTemplateView,
  TemplateQuestionInput,
} from "@/modules/appraisify/domain/models"

function getPrisma() {
  const prisma = getPrismaClient()
  if (!prisma) throw new Error("Database is not configured")
  return prisma
}

const templateInclude = {
  questions: { orderBy: { order: "asc" } },
} satisfies Prisma.AppraisalTemplateInclude

type PrismaTemplate = Prisma.AppraisalTemplateGetPayload<{ include: typeof templateInclude }>

function mapTemplate(t: PrismaTemplate): AppraisalTemplateView {
  return {
    id: t.id,
    name: t.name,
    archived: t.archived,
    updatedAt: t.updatedAt.toISOString(),
    questions: t.questions.map((q) => ({
      id: q.id,
      order: q.order,
      section: q.section,
      text: q.text,
      description: q.description,
    })),
  }
}

export type SaveTemplateInput = {
  orgId: string
  name: string
  questions: TemplateQuestionInput[]
}

export const appraisalTemplateRepository = {
  /** Non-archived templates with their question counts (list + dropdown). */
  async listForOrg(orgId: string): Promise<AppraisalTemplateSummary[]> {
    const prisma = getPrisma()
    const rows = await prisma.appraisalTemplate.findMany({
      where: { organizationId: orgId, archived: false },
      select: { id: true, name: true, updatedAt: true, _count: { select: { questions: true } } },
      orderBy: { name: "asc" },
    })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      questionCount: r._count.questions,
      updatedAt: r.updatedAt.toISOString(),
    }))
  },

  async getForOrg(id: string, orgId: string): Promise<AppraisalTemplateView | null> {
    const prisma = getPrisma()
    const row = await prisma.appraisalTemplate.findFirst({
      where: { id, organizationId: orgId },
      include: templateInclude,
    })
    return row ? mapTemplate(row) : null
  },

  async create(input: SaveTemplateInput): Promise<string> {
    const prisma = getPrisma()
    const created = await prisma.appraisalTemplate.create({
      data: {
        organizationId: input.orgId,
        name: input.name,
        questions: {
          create: input.questions.map((q, i) => ({
            order: i + 1,
            section: q.section,
            text: q.text,
            description: q.description,
          })),
        },
      },
      select: { id: true },
    })
    return created.id
  },

  /** Rename + replace the whole question list (templates are replace-on-save). */
  async update(id: string, input: SaveTemplateInput): Promise<boolean> {
    const prisma = getPrisma()
    const existing = await prisma.appraisalTemplate.findFirst({
      where: { id, organizationId: input.orgId },
      select: { id: true },
    })
    if (!existing) return false
    await prisma.$transaction([
      prisma.appraisalTemplateQuestion.deleteMany({ where: { templateId: id } }),
      prisma.appraisalTemplate.update({
        where: { id },
        data: {
          name: input.name,
          questions: {
            create: input.questions.map((q, i) => ({
              order: i + 1,
              section: q.section,
              text: q.text,
              description: q.description,
            })),
          },
        },
      }),
    ])
    return true
  },

  async archive(id: string, orgId: string): Promise<boolean> {
    const prisma = getPrisma()
    const res = await prisma.appraisalTemplate.updateMany({
      where: { id, organizationId: orgId },
      data: { archived: true },
    })
    return res.count > 0
  },

  /** Ordered questions for snapshotting onto a new appraisal. */
  async getQuestionsForSnapshot(
    id: string,
    orgId: string,
  ): Promise<Array<{ order: number; section: string | null; text: string; description: string | null }> | null> {
    const prisma = getPrisma()
    const row = await prisma.appraisalTemplate.findFirst({
      where: { id, organizationId: orgId },
      select: { questions: { orderBy: { order: "asc" }, select: { order: true, section: true, text: true, description: true } } },
    })
    if (!row) return null
    return row.questions
  },
}
