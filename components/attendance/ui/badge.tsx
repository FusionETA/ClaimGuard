import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        // Attendance-specific statuses
        "clocked-in": "border-transparent bg-success/15 text-success",
        "clocked-out": "border-border/60 bg-surface-lowest text-muted-foreground",
        "on-time": "border-transparent bg-success/15 text-success",
        late: "border-transparent bg-tertiary/15 text-tertiary",
        "on-leave": "border-transparent bg-accent/20 text-accent",
        missing: "border-transparent bg-destructive/15 text-destructive",
        overtime: "border-transparent bg-primary/15 text-primary",
        offset: "border-transparent bg-success/15 text-success",
        unresolved: "border-transparent bg-tertiary/15 text-tertiary",
        pending: "border-transparent bg-muted text-muted-foreground",
        approved: "border-transparent bg-success/15 text-success",
        rejected: "border-transparent bg-destructive/15 text-destructive",
        "within-range": "border-transparent bg-success/15 text-success",
        "out-of-range": "border-transparent bg-destructive/15 text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
