import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
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
