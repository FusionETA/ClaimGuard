export type ClaimFormValues = {
  title: string
  chartOfAccountId: string
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
    chartOfAccountId: "",
    amount: "",
    spentAt: "",
    description: "",
    receiptUrl: "",
  },
  errors: {},
}
