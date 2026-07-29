"use server"

import { revalidatePath } from "next/cache"

import {
  archiveTemplate,
  saveTemplate,
  type SaveTemplateInput,
} from "@/modules/appraisify/application/services/appraisal-template.service"
import {
  aiAssistChat,
  aiImproveQuestion,
  type AiAssistChatInput,
  type AiImproveQuestionInput,
} from "@/modules/appraisify/application/services/appraisal-template-ai.service"

export async function aiAssistChatAction(input: AiAssistChatInput) {
  return aiAssistChat(input)
}

export async function aiImproveQuestionAction(input: AiImproveQuestionInput) {
  return aiImproveQuestion(input)
}

export async function saveTemplateAction(input: SaveTemplateInput) {
  const res = await saveTemplate(input)
  if (res.ok) {
    revalidatePath("/admin/appraisals/templates")
    revalidatePath("/admin/appraisals")
  }
  return res
}

export async function archiveTemplateAction(templateId: string) {
  const res = await archiveTemplate(templateId)
  if (res.ok) {
    revalidatePath("/admin/appraisals/templates")
    revalidatePath("/admin/appraisals")
  }
  return res
}
