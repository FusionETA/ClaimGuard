export type ClaimFormValues = {
  title: string
  chartOfAccountId: string
  amount: string
  spentAt: string
  description: string
  receiptUrl: string
  paymentType: "PERSONAL" | "COMPANY"
  payViaAccountId: string
  projectId: string
  claimType: "EXPENSE" | "MILEAGE"
  distance: string
  mileageOriginAddress: string
  mileageDestinationAddress: string
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
    paymentType: "PERSONAL",
    payViaAccountId: "",
    projectId: "",
    claimType: "EXPENSE",
    distance: "",
    mileageOriginAddress: "",
    mileageDestinationAddress: "",
  },
  errors: {},
}
