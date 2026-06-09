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
  /// Optional free-text "who you spent the money with" — client /
  /// colleague / counterparty. Capped at 200 chars server-side.
  spendingWith: string
  /// Free-text "where you spent" — merchant / vendor / restaurant.
  /// REQUIRED when paymentType=COMPANY; used as the Xero Spend Money
  /// Contact ("Bill To"). Optional context for PERSONAL claims.
  spendingAt: string
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
    spendingAt: "",
  },
  errors: {},
}
