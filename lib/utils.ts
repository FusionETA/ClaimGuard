import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Default currency formatter — Malaysian Ringgit (MYR), en-MY locale.
 * Renders as "RM 1,234.56". AltomateHR is Malaysia-first; pass a
 * `currency` argument (e.g. "USD", "SGD") when you need something
 * else.
 */
export function formatCurrency(
  value: number,
  currency: string = "MYR",
): string {
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value)
}

export function formatShortDate(value: string | Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value))
}

export function formatMonthLabel(value: string | Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
  }).format(new Date(value))
}

export function formatMonthYear(value: string | Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(new Date(value))
}

/**
 * First two letters of a person's name, uppercased — used for avatar fallbacks.
 * Splits on whitespace so "John Doe" → "JD", "John" → "JO" via .slice(0, 2).
 */
export function buildInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

/**
 * Format a leave-day count to a consistent 2-decimal display.
 * PRO_RATED accruals produce non-integer days (e.g. 5.25 after a
 * partial join month) so the UI needs predictable decimals.
 *
 * - `14` → `"14.00"`
 * - `5.25` → `"5.25"`
 * - `0` → `"0.00"`
 */
export function formatDays(value: number): string {
  return value.toFixed(2)
}
