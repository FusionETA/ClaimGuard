import { type LucideIcon } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export function MetricCard({
  title,
  value,
  icon: Icon,
  detail,
  className,
  compact = false,
}: {
  title: string
  value: string
  icon: LucideIcon
  detail?: string
  className?: string
  compact?: boolean
}) {
  return (
    <Card className={cn("rounded-2xl", className)}>
      <CardContent className={cn(compact ? "p-4" : "p-5")}>
        <div className={cn("flex items-center justify-between", compact ? "mb-3" : "mb-4")}>
          <div className={cn("rounded-2xl bg-primary/10 text-primary", compact ? "p-2.5" : "p-3")}>
            <Icon className={cn(compact ? "h-[18px] w-[18px]" : "h-5 w-5")} />
          </div>
          {detail ? (
            <span
              className={cn(
                "font-semibold uppercase text-muted-foreground",
                compact ? "text-[11px] tracking-[0.14em]" : "text-xs tracking-[0.16em]"
              )}
            >
              {detail}
            </span>
          ) : null}
        </div>
        <p className={cn("font-medium text-muted-foreground", compact ? "text-xs" : "text-sm")}>
          {title}
        </p>
        <p className={cn("mt-1 font-black tracking-tight", compact ? "text-[2rem]" : "text-3xl")}>
          {value}
        </p>
      </CardContent>
    </Card>
  )
}
