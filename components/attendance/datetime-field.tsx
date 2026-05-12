"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type Props = {
  /** Local-datetime string ("YYYY-MM-DDTHH:MM") — same format <input type="datetime-local"> emits. */
  value: string
  onChange: (next: string) => void
  /** Optional id for label association. */
  id?: string
  /** When true, render a smaller variant. */
  compact?: boolean
  disabled?: boolean
}

function pad(n: number): string {
  return String(n).padStart(2, "0")
}

function parts(value: string): {
  date: string
  hour12: string
  minute: string
  meridiem: "AM" | "PM"
} {
  if (!value) {
    return { date: "", hour12: "", minute: "", meridiem: "AM" }
  }
  const [date, time = "00:00"] = value.split("T")
  const [hStr = "0", mStr = "0"] = time.split(":")
  const h24 = Math.max(0, Math.min(23, Number.parseInt(hStr, 10) || 0))
  const minute = Math.max(0, Math.min(59, Number.parseInt(mStr, 10) || 0))
  const meridiem: "AM" | "PM" = h24 >= 12 ? "PM" : "AM"
  const hour12 = ((h24 + 11) % 12) + 1
  return {
    date,
    hour12: String(hour12),
    minute: pad(minute),
    meridiem,
  }
}

function compose(
  date: string,
  hour12: string,
  minute: string,
  meridiem: "AM" | "PM",
): string {
  if (!date) return ""
  const h12 = Number.parseInt(hour12, 10) || 12
  const m = Number.parseInt(minute, 10) || 0
  const h24 =
    meridiem === "AM"
      ? h12 === 12
        ? 0
        : h12
      : h12 === 12
        ? 12
        : h12 + 12
  return `${date}T${pad(h24)}:${pad(m)}`
}

/**
 * Custom date + time editor that replaces the browser's
 * `<input type="datetime-local">` widget. Lets the user either type
 * directly into the fields (date in YYYY-MM-DD, hour 1–12, minute
 * 0–59) or open the calendar popover for visual day picking. Emits the
 * same `YYYY-MM-DDTHH:MM` string the native control would.
 */
export function DateTimeField({
  value,
  onChange,
  id,
  compact = false,
  disabled,
}: Props) {
  const { date, hour12, minute, meridiem } = useMemo(() => parts(value), [value])

  function update(next: Partial<{
    date: string
    hour12: string
    minute: string
    meridiem: "AM" | "PM"
  }>) {
    onChange(
      compose(
        next.date ?? date,
        next.hour12 ?? hour12 ?? "12",
        next.minute ?? minute ?? "00",
        next.meridiem ?? meridiem,
      ),
    )
  }

  return (
    <div className={cn("space-y-2", compact && "space-y-1.5")}>
      <CalendarPicker
        id={id}
        value={date}
        onChange={(d) => update({ date: d })}
        disabled={disabled}
        compact={compact}
      />
      <div className="flex items-center gap-1.5">
        <NumericField
          ariaLabel="Hour"
          placeholder="HH"
          value={hour12}
          min={1}
          max={12}
          format={(n) => String(n)}
          onCommit={(v) => update({ hour12: v })}
          compact={compact}
          disabled={disabled}
        />
        <span className="text-sm font-bold text-muted-foreground">:</span>
        <NumericField
          ariaLabel="Minute"
          placeholder="MM"
          value={minute}
          min={0}
          max={59}
          format={(n) => pad(n)}
          onCommit={(v) => update({ minute: v })}
          compact={compact}
          disabled={disabled}
        />
        <div className="inline-flex overflow-hidden rounded-md border border-border/60 bg-card">
          {(["AM", "PM"] as const).map((mer) => (
            <button
              key={mer}
              type="button"
              disabled={disabled}
              onClick={() => update({ meridiem: mer })}
              className={cn(
                "px-2 text-[11px] font-semibold transition-colors",
                compact ? "py-1.5" : "py-2",
                meridiem === mer
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-surface-low hover:text-foreground",
              )}
            >
              {mer}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- */
/*  Typeable numeric field (hour / minute)                            */
/* ----------------------------------------------------------------- */

function NumericField({
  ariaLabel,
  placeholder,
  value,
  min,
  max,
  format,
  onCommit,
  compact,
  disabled,
}: {
  ariaLabel: string
  placeholder: string
  value: string
  min: number
  max: number
  format: (n: number) => string
  onCommit: (next: string) => void
  compact?: boolean
  disabled?: boolean
}) {
  // Local draft so the user can clear the field and type without the
  // parent fighting back mid-edit.
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])

  function commit(raw: string) {
    const digits = raw.replace(/\D/g, "")
    if (digits.length === 0) {
      // Revert if user clears the field — keep the last committed value.
      setDraft(value)
      return
    }
    const n = Math.max(min, Math.min(max, Number.parseInt(digits, 10)))
    const next = format(n)
    setDraft(next)
    onCommit(next)
  }

  return (
    <Input
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={draft}
      maxLength={2}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur()
        }
      }}
      className={cn(
        "w-12 px-1 text-center tabular-nums",
        compact ? "h-9" : "h-10",
      )}
    />
  )
}

/* ----------------------------------------------------------------- */
/*  Calendar popover                                                  */
/* ----------------------------------------------------------------- */

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"] as const
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

function isoForLocal(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function fmtDateForDisplay(iso: string): string {
  if (!iso) return "Pick a date"
  const [y, m, d] = iso.split("-").map((n) => Number.parseInt(n, 10))
  if (!y || !m || !d) return "Pick a date"
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function CalendarPicker({
  id,
  value,
  onChange,
  disabled,
  compact,
}: {
  id?: string
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [popoverPos, setPopoverPos] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Anchor month for the grid — defaults to the selected value or today.
  const initialAnchor = useMemo(() => {
    if (value) {
      const [y, m] = value.split("-").map((n) => Number.parseInt(n, 10))
      if (y && m) return new Date(y, m - 1, 1)
    }
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  }, [value])
  const [anchor, setAnchor] = useState(initialAnchor)

  // Re-sync the grid when the controlled value jumps to another month.
  useEffect(() => {
    if (!value) return
    const [y, m] = value.split("-").map((n) => Number.parseInt(n, 10))
    if (!y || !m) return
    if (anchor.getFullYear() !== y || anchor.getMonth() !== m - 1) {
      setAnchor(new Date(y, m - 1, 1))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // Close on outside click / Esc — the popover lives in a portal, so we
  // check both the trigger root *and* the popover ref.
  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const t = e.target as Node
      if (rootRef.current?.contains(t)) return
      if (popoverRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("mousedown", onClick)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onClick)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  // Position the portalled popover under the trigger; reposition on
  // scroll / resize so it tracks while the dialog scrolls.
  useLayoutEffect(() => {
    if (!open) return
    function place() {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const popWidth = Math.min(window.innerWidth - 32, 288) // 18rem
      const popHeight = 360 // rough upper bound
      let top = rect.bottom + 8
      let left = rect.left
      // Flip up if it would clip the bottom of the viewport.
      if (top + popHeight > window.innerHeight - 8) {
        top = Math.max(8, rect.top - popHeight - 8)
      }
      // Keep within horizontal viewport.
      if (left + popWidth > window.innerWidth - 16) {
        left = window.innerWidth - popWidth - 16
      }
      if (left < 16) left = 16
      setPopoverPos({ top, left, width: popWidth })
    }
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [open])

  const todayIso = useMemo(() => isoForLocal(new Date()), [])

  const grid = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    const startDow = first.getDay()
    const start = new Date(first)
    start.setDate(first.getDate() - startDow)
    const cells: Array<{ date: Date; inMonth: boolean; iso: string }> = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      cells.push({
        date: d,
        inMonth: d.getMonth() === anchor.getMonth(),
        iso: isoForLocal(d),
      })
    }
    return cells
  }, [anchor])

  function moveMonth(delta: number) {
    setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1))
  }

  function pick(iso: string) {
    onChange(iso)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md border border-input bg-card px-3 text-left text-sm font-medium transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          compact ? "h-9" : "h-10",
        )}
      >
        <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "flex-1 truncate tabular-nums",
            !value && "text-muted-foreground",
          )}
        >
          {fmtDateForDisplay(value)}
        </span>
      </button>
      {open && mounted && popoverPos
        ? createPortal(
        <div
          ref={popoverRef}
          style={{ top: popoverPos.top, left: popoverPos.left, width: popoverPos.width }}
          className="fixed z-[60] rounded-2xl border border-border/60 bg-card p-3 shadow-panel"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => moveMonth(-1)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-low hover:text-foreground"
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <p className="text-sm font-bold text-foreground">
              {MONTH_NAMES[anchor.getMonth()]} {anchor.getFullYear()}
            </p>
            <button
              type="button"
              onClick={() => moveMonth(1)}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-low hover:text-foreground"
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {WEEKDAYS.map((d, i) => (
              <span
                key={`${d}-${i}`}
                className="py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {d}
              </span>
            ))}
            {grid.map(({ iso, date, inMonth }) => {
              const isSelected = iso === value
              const isToday = iso === todayIso
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => pick(iso)}
                  className={cn(
                    "flex h-8 items-center justify-center rounded-md text-xs font-medium transition-colors",
                    isSelected
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : inMonth
                        ? "text-foreground hover:bg-surface-low"
                        : "text-muted-foreground/50 hover:bg-surface-low",
                    !isSelected && isToday && "ring-1 ring-primary/40",
                  )}
                  aria-current={isToday ? "date" : undefined}
                  aria-pressed={isSelected}
                >
                  {date.getDate()}
                </button>
              )
            })}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2">
            <button
              type="button"
              onClick={() => pick(todayIso)}
              className="text-xs font-semibold text-primary hover:underline"
            >
              Today
            </button>
            {value ? (
              <button
                type="button"
                onClick={() => pick("")}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>,
        document.body,
      )
        : null}
    </div>
  )
}
