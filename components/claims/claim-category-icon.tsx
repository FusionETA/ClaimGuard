import type { ComponentType } from "react"

import {
  BriefcaseBusiness,
  CarFront,
  Dumbbell,
  HeartPulse,
  Laptop,
  Plane,
  Receipt,
  UtensilsCrossed,
} from "lucide-react"

import { type ClaimCategory } from "@/modules/claims/domain/models"
import { cn } from "@/lib/utils"

const iconMap = {
  TRAVEL: Plane,
  TRANSPORT: CarFront,
  MEAL: UtensilsCrossed,
  MEDICAL: HeartPulse,
  WELLNESS: Dumbbell,
  HARDWARE: Laptop,
  OFFICE: BriefcaseBusiness,
  OTHER: Receipt,
} satisfies Record<ClaimCategory, ComponentType<{ className?: string }>>

export function ClaimCategoryIcon({
  category,
  className,
}: {
  category: ClaimCategory
  className?: string
}) {
  const Icon = iconMap[category]

  return <Icon className={cn("h-4 w-4", className)} />
}
