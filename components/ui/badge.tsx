import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em]",
  {
    variants: {
      variant: {
        default: "bg-primary/10 text-primary",
        pending: "bg-tertiary-fixed text-tertiary",
        approved: "bg-primary/10 text-primary",
        paid: "bg-secondary text-secondary-foreground",
        rejected: "bg-destructive/10 text-destructive",
        success: "bg-success/10 text-success",
        outline: "border border-border text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
