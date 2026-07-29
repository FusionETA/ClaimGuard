"use server"

import { revalidatePath } from "next/cache"

import {
  createAppraisalsForEmployees,
  type CreateAppraisalsInput,
} from "@/modules/appraisify/application/services/appraisal-workflow.service"

/** Create appraisal cycles for the selected employees. */
export async function createAppraisalsAction(input: CreateAppraisalsInput) {
  const result = await createAppraisalsForEmployees(input)
  if (result.ok) {
    revalidatePath("/admin/appraisals")
  }
  return result
}
