import type { ClaimCategory } from "@/modules/claims/domain/models"

export const categoryMeta: Record<
  ClaimCategory,
  { label: string; description: string }
> = {
  TRAVEL: {
    label: "Travel",
    description: "Flights, hotels, and conference-related travel.",
  },
  TRANSPORT: {
    label: "Transport",
    description: "Taxi, rideshare, parking, and local transit.",
  },
  MEAL: {
    label: "Meals",
    description: "Client lunches, team meals, and approved food spend.",
  },
  MEDICAL: {
    label: "Medical",
    description: "Eligible health expenses and annual checkups.",
  },
  WELLNESS: {
    label: "Wellness",
    description: "Approved wellness stipends and gym reimbursements.",
  },
  HARDWARE: {
    label: "Hardware",
    description: "Devices, peripherals, and approved workstation equipment.",
  },
  OFFICE: {
    label: "Office",
    description: "Office supplies and low-risk equipment purchases.",
  },
  OTHER: {
    label: "Other",
    description: "Catch-all category for policy-reviewed expenses.",
  },
}

