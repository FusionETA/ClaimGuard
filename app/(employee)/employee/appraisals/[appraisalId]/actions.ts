"use server"

import { revalidatePath } from "next/cache"

import {
  submitAppraisalPhase,
  type SubmitPhaseInput,
} from "@/modules/appraisify/application/services/appraisal-workflow.service"

/**
 * Persist a phase (draft or final submit). All gating + validation lives in
 * the service; this action only orchestrates + revalidates.
 */
export async function submitAppraisalPhaseAction(input: SubmitPhaseInput) {
  const result = await submitAppraisalPhase(input)
  if (result.ok) {
    revalidatePath("/employee/appraisals")
    revalidatePath(`/employee/appraisals/${input.appraisalId}`)
  }
  return result
}
