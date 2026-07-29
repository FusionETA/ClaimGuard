"use server"

import {
  aiSetupChat,
  type AiSetupChatInput,
} from "@/modules/appraisify/application/services/appraisal-template-ai.service"

export async function aiSetupChatAction(input: AiSetupChatInput) {
  return aiSetupChat(input)
}
