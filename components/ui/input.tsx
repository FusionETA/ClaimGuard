import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    // iOS Safari styles <input type="date|time|datetime-local|month|week">
    // via the ::-webkit-date-and-time-value and ::-webkit-datetime-edit
    // shadow DOM elements with default padding that makes these inputs
    // render visibly taller than text inputs. Strip the native appearance
    // and zero the inner element padding so all input variants match h-12.
    const isDateLike =
      type === "date" || type === "time" || type === "datetime-local" || type === "month" || type === "week"

    return (
      <input
        type={type}
        suppressHydrationWarning
        className={cn(
          "flex h-12 min-w-0 w-full max-w-full rounded-2xl border border-border/80 bg-card px-4 py-2 text-base text-foreground shadow-sm transition-colors file:border-0 file:bg-transparent file:text-base file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm sm:file:text-sm",
          // Error state — applied automatically when callers set aria-invalid.
          "aria-[invalid=true]:border-destructive aria-[invalid=true]:bg-destructive/5 aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-destructive/30",
          // iOS date/time normalisation (no effect on desktop browsers).
          isDateLike &&
            "appearance-none [-webkit-appearance:none] [&::-webkit-date-and-time-value]:m-0 [&::-webkit-date-and-time-value]:p-0 [&::-webkit-date-and-time-value]:text-left [&::-webkit-date-and-time-value]:leading-[1.5] [&::-webkit-datetime-edit]:p-0",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
