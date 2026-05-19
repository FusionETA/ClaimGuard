export type ClaimFormValues = {
  title: string
  chartOfAccountId: string
  amount: string
  spentAt: string
  description: string
  receiptUrl: string
  currency: string
  paymentType: "PERSONAL" | "COMPANY"
  payViaAccountId: string
  projectId: string
  claimType: "EXPENSE" | "MILEAGE"
  distance: string
  mileageOriginAddress: string
  mileageDestinationAddress: string
  /// Optional free-text "who you spent the money with" — client name,
  /// vendor name, internal team. Capped at 200 chars server-side.
  spendingWith: string
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
    currency: "",
    paymentType: "PERSONAL",
    payViaAccountId: "",
    projectId: "",
    claimType: "EXPENSE",
    distance: "",
    mileageOriginAddress: "",
    mileageDestinationAddress: "",
    spendingWith: "",
  },
  errors: {},
}
