// FormState shapes for the My-Claims row actions (delete + attach
// more). Lives in form-state.ts (not actions.ts) because Next.js
// rejects non-async exports from "use server" files.

import type { BaseFormState } from "@/lib/form-state"

/** Discriminated state for the delete-claim action. */
export type DeleteClaimFormState = BaseFormState & {
  /** Surfaced so the client can scroll-to-row or toast precisely. */
  claimId?: string
}

export const initialDeleteClaimFormState: DeleteClaimFormState = {
  status: "idle",
  message: "",
}

/** Discriminated state for the attach-supporting-files action. */
export type AttachClaimFilesFormState = BaseFormState & {
  claimId?: string
  /** Count of successfully attached files (zero when an error happened). */
  inserted?: number
}

export const initialAttachClaimFilesFormState: AttachClaimFilesFormState = {
  status: "idle",
  message: "",
}

/** Per-field error map for the edit-claim action. */
export type UpdateClaimFieldErrors = Partial<{
  title: string
  amount: string
  spentAt: string
  description: string
  spendingAt: string
  spendingWith: string
}>

/** Discriminated state for the edit-claim action. */
export type UpdateClaimFormState = BaseFormState & {
  claimId?: string
  fieldErrors?: UpdateClaimFieldErrors
}

export const initialUpdateClaimFormState: UpdateClaimFormState = {
  status: "idle",
  message: "",
}

/** Discriminated state for the replace-primary-receipt action. */
export type ReplaceReceiptFormState = BaseFormState & {
  claimId?: string
  /** URL the dialog can swap into the "View receipt" link without
   *  waiting for the route revalidation to re-fetch the row. */
  receiptUrl?: string
}

export const initialReplaceReceiptFormState: ReplaceReceiptFormState = {
  status: "idle",
  message: "",
}
