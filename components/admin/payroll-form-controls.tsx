"use client"

import * as React from "react"
import { useMemo, useState } from "react"
import { Check, Search } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

const EMPTY_SELECT_VALUE = "__payroll_empty__"

/**
 * Above this many (non-group-label) options, the dropdown renders a
 * search box so admins can type to filter instead of scrolling a long
 * chart-of-accounts list.
 */
const SEARCHABLE_OPTION_THRESHOLD = 7

/** Flatten a React node into plain text for case-insensitive filtering. */
function nodeToText(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeToText).join("")
  if (React.isValidElement(node)) {
    return nodeToText((node.props as { children?: React.ReactNode }).children)
  }
  return ""
}

type SelectOption = {
  disabled?: boolean
  groupLabel?: boolean
  label: React.ReactNode
  value: string
}

type NativeSelectProps = Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  "children"
> & {
  children: React.ReactNode
}

/**
 * Compatibility wrapper for payroll forms that were written with native
 * <select><option /></select> markup. It renders the shared app Select while
 * keeping the same FormData name/value behavior for server actions.
 */
export function NativeSelect({
  children,
  className,
  defaultValue,
  disabled,
  id,
  name,
  onChange,
  value,
}: NativeSelectProps) {
  const options = useMemo(() => parseSelectOptions(children), [children])
  const isControlled = value !== undefined
  const [localValue, setLocalValue] = useState(String(defaultValue ?? ""))
  const selectedValue = isControlled ? String(value ?? "") : localValue
  const radixValue =
    selectedValue === "" ? EMPTY_SELECT_VALUE : selectedValue

  // Pre-compute a lowercased text label for each option once so the
  // filter doesn't re-flatten React nodes on every keystroke.
  const searchableOptions = useMemo(
    () => options.map((o) => ({ ...o, text: nodeToText(o.label).toLowerCase() })),
    [options],
  )
  const optionCount = useMemo(
    () => searchableOptions.filter((o) => !o.groupLabel).length,
    [searchableOptions],
  )
  const searchable = optionCount > SEARCHABLE_OPTION_THRESHOLD

  const [query, setQuery] = useState("")
  const trimmedQuery = query.trim().toLowerCase()
  const visibleOptions = useMemo(() => {
    if (!trimmedQuery) return searchableOptions
    // Hide group-label rows while filtering — they'd otherwise leave
    // empty section headers above filtered-out children.
    return searchableOptions.filter(
      (o) => !o.groupLabel && o.text.includes(trimmedQuery),
    )
  }, [searchableOptions, trimmedQuery])

  function handleValueChange(next: string) {
    const actual = next === EMPTY_SELECT_VALUE ? "" : next
    if (!isControlled) setLocalValue(actual)

    onChange?.({
      target: { name: name ?? "", value: actual },
    } as React.ChangeEvent<HTMLSelectElement>)
  }

  return (
    <>
      {name ? <input type="hidden" name={name} value={selectedValue} /> : null}
      <Select
        value={radixValue}
        onValueChange={handleValueChange}
        disabled={disabled}
        onOpenChange={(open) => {
          // Clear the filter each time the menu closes so it reopens
          // showing the full list.
          if (!open) setQuery("")
        }}
      >
        <SelectTrigger
          id={id}
          className={cn("h-10 rounded-2xl text-sm", className)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {searchable ? (
            <div className="sticky top-0 z-10 -mx-1 -mt-1 mb-1 border-b border-border/60 bg-card/95 px-2 py-2 backdrop-blur-xl">
              <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-background px-2.5 py-1.5">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  type="text"
                  value={query}
                  placeholder="Search…"
                  onChange={(e) => setQuery(e.target.value)}
                  // Stop keystrokes from reaching Radix's built-in
                  // typeahead (which would steal focus and jump items).
                  onKeyDown={(e) => e.stopPropagation()}
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
          ) : null}
          {visibleOptions.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No matches
            </div>
          ) : (
            visibleOptions.map((option) => (
              <SelectItem
                key={option.value === "" ? EMPTY_SELECT_VALUE : option.value}
                value={option.value === "" ? EMPTY_SELECT_VALUE : option.value}
                disabled={option.disabled}
                className={
                  option.groupLabel
                    ? "pointer-events-none mt-1 bg-transparent text-[11px] font-bold uppercase tracking-wide text-muted-foreground"
                    : undefined
                }
              >
                {option.label}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </>
  )
}

function parseSelectOptions(children: React.ReactNode): SelectOption[] {
  const out: SelectOption[] = []
  React.Children.toArray(children)
    .filter(React.isValidElement)
    .forEach((child, index) => {
      const props = child.props as {
        children?: React.ReactNode
        disabled?: boolean
        label?: React.ReactNode
        value?: string | number
      }

      if (props.label !== undefined) {
        out.push({
          disabled: true,
          groupLabel: true,
          label: props.label,
          value: `__payroll_group_${index}__`,
        })
        out.push(...parseSelectOptions(props.children))
        return
      }

      const optionValue =
        props.value === undefined
          ? String(props.children ?? "")
          : String(props.value)

      out.push({
        disabled: props.disabled,
        label: props.children,
        value: optionValue,
      })
    })
  return out
}

export function Toggle(props: {
  /** Uncontrolled initial state. Ignored when `checked` is provided. */
  defaultChecked?: boolean
  /** Controlled checked state. When set, the toggle is controlled and
   *  `onCheckedChange` should be supplied to update it. */
  checked?: boolean
  /** Disable interaction (e.g. a value forced by another field). When
   *  disabled + checked, a hidden input keeps the value in FormData
   *  since disabled checkboxes don't submit. */
  disabled?: boolean
  onCheckedChange?: (checked: boolean) => void
  /** Optional helper text shown under the question. */
  hint?: string
  label?: string
  name: string
  question?: string
}) {
  const isControlled = props.checked !== undefined
  const checkboxProps = isControlled
    ? {
        checked: props.checked,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
          props.onCheckedChange?.(e.target.checked),
      }
    : { defaultChecked: props.defaultChecked ?? false }

  return (
    <label
      className={cn(
        "group inline-flex min-h-11 w-full items-center justify-between gap-4 rounded-2xl border border-border/70 bg-card px-4 py-2 text-sm shadow-sm transition",
        props.disabled
          ? "cursor-not-allowed opacity-70"
          : "cursor-pointer hover:border-primary/40",
      )}
    >
      <input
        type="checkbox"
        name={props.name}
        value="true"
        disabled={props.disabled}
        className="peer sr-only"
        {...checkboxProps}
      />
      {/* A disabled checkbox is omitted from FormData. When it's locked
          ON we still need the value to submit, so mirror it via a hidden
          input. */}
      {props.disabled && (isControlled ? props.checked : props.defaultChecked) ? (
        <input type="hidden" name={props.name} value="true" />
      ) : null}
      {props.question ? (
        <span className="flex flex-col">
          <span className="font-medium text-foreground">{props.question}</span>
          {props.hint ? (
            <span className="text-xs font-normal text-muted-foreground">
              {props.hint}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="inline-flex shrink-0 items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-md border border-border bg-background text-transparent shadow-sm transition group-has-[:checked]:border-primary group-has-[:checked]:bg-primary group-has-[:checked]:text-primary-foreground">
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </span>
        <span className="font-medium text-foreground">{props.label ?? "Yes"}</span>
      </span>
    </label>
  )
}
