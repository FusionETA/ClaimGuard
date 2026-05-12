"use client"

import * as React from "react"
import { useMemo, useState } from "react"
import { Check } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

const EMPTY_SELECT_VALUE = "__payroll_empty__"

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
  const options = useMemo(
    () =>
      React.Children.toArray(children)
        .filter(React.isValidElement)
        .map((child) => {
          const props = child.props as {
            children?: React.ReactNode
            disabled?: boolean
            value?: string | number
          }
          const optionValue =
            props.value === undefined
              ? String(props.children ?? "")
              : String(props.value)

          return {
            disabled: props.disabled,
            label: props.children,
            value: optionValue,
          }
        }),
    [children],
  )
  const isControlled = value !== undefined
  const [localValue, setLocalValue] = useState(String(defaultValue ?? ""))
  const selectedValue = isControlled ? String(value ?? "") : localValue
  const radixValue =
    selectedValue === "" ? EMPTY_SELECT_VALUE : selectedValue

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
      >
        <SelectTrigger
          id={id}
          className={cn("h-10 rounded-2xl text-sm", className)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value === "" ? EMPTY_SELECT_VALUE : option.value}
              value={option.value === "" ? EMPTY_SELECT_VALUE : option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  )
}

export function Toggle(props: {
  defaultChecked: boolean
  label?: string
  name: string
  question?: string
}) {
  return (
    <label className="group inline-flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 rounded-2xl border border-border/70 bg-card px-4 py-2 text-sm shadow-sm transition hover:border-primary/40">
      <input
        type="checkbox"
        name={props.name}
        defaultChecked={props.defaultChecked}
        value="true"
        className="peer sr-only"
      />
      {props.question ? (
        <span className="font-medium text-foreground">{props.question}</span>
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
