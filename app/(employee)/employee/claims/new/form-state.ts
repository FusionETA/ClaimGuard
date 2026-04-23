import type { ClaimCategory } from "@/modules/claims/domain/models"

export type ClaimFormValues = {
  title: string
  category: ClaimCategory
  amount: string
  spentAt: string
  description: string
  receiptUrl: string
}

export type ClaimFormState = {
  status: "idle" | "success" | "error"
  message: string
  values: ClaimFormValues
  errors: Partial<Record<keyof ClaimFormValues, string>>
}

export const initialClaimFormState: ClaimFormState = {
  status: "idle",
  message: "",
  values: {
    title: "",
    category: "TRAVEL",
    amount: "",
    spentAt: "",
    description: "",
    receiptUrl: "",
  },
  errors: {},
}
