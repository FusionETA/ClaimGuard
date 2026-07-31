"use client"

import { useState } from "react"

import { cn } from "@/lib/utils"

/**
 * Two-tab switcher for the payroll run detail page so the payslips
 * aren't buried under the "needs setup" / "not yet on a payslip" cards.
 * Defaults to the Payslips tab.
 *
 * Both panels stay MOUNTED (toggled with `hidden`, not conditional
 * render) for one specific reason: the Payroll Summary PDF is produced
 * by `window.print()`, which serialises whatever is in the DOM. If the
 * payslips were unmounted while the setup tab was active, printing from
 * that tab would produce a blank PDF. So the payslips panel is always
 * present and always visible in print (`print:block`); the tab bar and
 * setup panel are `print:hidden`.
 */
export function PayrollRunContentTabs(props: {
  payslips: React.ReactNode
  setup: React.ReactNode
  payslipCount: number
  setupCount: number
  defaultTab?: "payslips" | "setup"
}) {
  const [tab, setTab] = useState<"payslips" | "setup">(
    props.defaultTab ?? "payslips",
  )

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Run sections"
        className="flex flex-wrap gap-2 print:hidden"
      >
        <TabButton
          active={tab === "payslips"}
          onClick={() => setTab("payslips")}
          label="Payslips"
          count={props.payslipCount}
        />
        <TabButton
          active={tab === "setup"}
          onClick={() => setTab("setup")}
          label="Needs attention"
          count={props.setupCount}
          accent
        />
      </div>

      <div className={cn(tab === "payslips" ? "block" : "hidden", "print:block")}>
        {props.payslips}
      </div>
      <div className={cn(tab === "setup" ? "block" : "hidden", "print:hidden")}>
        {props.setup}
      </div>
    </div>
  )
}

function TabButton(props: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  accent?: boolean
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      onClick={props.onClick}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors",
        props.active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border/60 bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {props.label}
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
          props.active
            ? "bg-primary-foreground/20 text-primary-foreground"
            : props.accent
              ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              : "bg-muted text-muted-foreground",
        )}
      >
        {props.count}
      </span>
    </button>
  )
}
