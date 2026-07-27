"use client"

import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"
import type {
  AppraisalPhase,
  AppraisalStage,
} from "@/modules/appraisify/domain/models"

/** Material Symbols Outlined icon (font loaded in the appraisals layout). */
export function Icon({
  name,
  className,
  filled,
  style,
}: {
  name: string
  className?: string
  filled?: boolean
  style?: React.CSSProperties
}) {
  return (
    <span
      className={cn("material-symbols-outlined", className)}
      style={{ ...(filled ? { fontVariationSettings: "'FILL' 1" } : {}), ...style }}
      aria-hidden
    >
      {name}
    </span>
  )
}

/** Shimmer skeleton block. Width in px (number) or any CSS length (string). */
export function Skel({
  w,
  className,
}: {
  w?: number | string
  className?: string
}) {
  return (
    <span
      className={cn("skel", className)}
      style={{ width: typeof w === "number" ? `${w}px` : w }}
    />
  )
}

/**
 * Reproduces the reference's async-load shimmer: fields start in a loading
 * state and reveal after a short delay. In Phase B this can be wired to real
 * pending state (or removed) — the skeleton markup stays the same.
 */
export function useSimulatedLoad(ms = 650): boolean {
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), ms)
    return () => clearTimeout(t)
  }, [ms])
  return loading
}

/** Stage → status label + the colour of its indicator dot. */
export function stageBadge(stage: AppraisalStage): {
  label: string
  dot: string
} {
  switch (stage) {
    case "INITIALIZED":
      return { label: "Self-Assessment Due", dot: "bg-amber-500" }
    case "REVIEWER_PENDING":
      return { label: "Reviewer Pending", dot: "bg-indigo-500" }
    case "PARTNER_PENDING":
      return { label: "Partner Pending", dot: "bg-purple-500" }
    case "SUBMITTED":
      return { label: "Completed", dot: "bg-emerald-500" }
  }
}

/**
 * Calm status pill: a neutral background with a small colour-coded dot and
 * muted text — keeps status legible without the noise of many saturated
 * colour-filled badges in a dense table.
 */
export function StatusBadge({ stage }: { stage: AppraisalStage }) {
  const { label, dot } = stageBadge(stage)
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      {label}
    </span>
  )
}

/**
 * Per-phase accent palette. Mirrors the reference: reviewee=amber/primary,
 * reviewer=emerald, partner=purple. Kept in the UI layer (not domain) because
 * it is Tailwind-class presentation only.
 */
export type PhaseAccent = {
  /** short label for the editable column header ("Self" / "Reviewer" / "Partner") */
  columnLabel: string
  /** header pill classes, e.g. "bg-amber-100 text-amber-700" */
  pill: string
  /** editable column header cell background */
  headBg: string
  /** editable input-column cell background */
  cellBg: string
  /** submit + primary accent button classes */
  button: string
  /** progress bar fill */
  progress: string
  /** section-tab active classes */
  tabActive: string
  /** section-tab hover classes */
  tabHover: string
  /** input border + focus ring utility classes */
  inputBorder: string
  /** phase banner container classes */
  bannerBg: string
  /** phase banner text color */
  bannerText: string
}

export const PHASE_ACCENT: Record<AppraisalPhase, PhaseAccent> = {
  reviewee: {
    columnLabel: "Self",
    pill: "bg-amber-100 text-amber-700",
    headBg: "bg-amber-50/50 text-amber-700",
    cellBg: "bg-amber-50/20",
    button: "bg-amber-500 text-white hover:bg-amber-600 shadow-sm shadow-amber-500/30",
    progress: "bg-amber-500",
    tabActive: "border-amber-500 bg-amber-500 text-white",
    tabHover: "hover:border-amber-500 hover:text-amber-700",
    inputBorder: "border-amber-200 focus:ring-amber-500",
    bannerBg: "bg-amber-50 border-amber-200",
    bannerText: "text-amber-800",
  },
  reviewer: {
    columnLabel: "Reviewer",
    pill: "bg-emerald-100 text-emerald-700",
    headBg: "bg-emerald-50/60 text-emerald-700",
    cellBg: "bg-emerald-50/20",
    button: "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm shadow-emerald-500/30",
    progress: "bg-emerald-500",
    tabActive: "border-emerald-500 bg-emerald-500 text-white",
    tabHover: "hover:border-emerald-500 hover:text-emerald-700",
    inputBorder: "border-emerald-200 focus:ring-emerald-500",
    bannerBg: "bg-emerald-50 border-emerald-200",
    bannerText: "text-emerald-800",
  },
  partner: {
    columnLabel: "Partner",
    pill: "bg-purple-100 text-purple-700",
    headBg: "bg-purple-50/60 text-purple-700",
    cellBg: "bg-purple-50/20",
    button: "bg-purple-600 text-white hover:bg-purple-700 shadow-sm shadow-purple-500/30",
    progress: "bg-purple-500",
    tabActive: "border-purple-500 bg-purple-500 text-white",
    tabHover: "hover:border-purple-500 hover:text-purple-700",
    inputBorder: "border-purple-200 focus:ring-purple-500",
    bannerBg: "bg-purple-50 border-purple-200",
    bannerText: "text-purple-800",
  },
}

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const

/**
 * Format an ISO date (or null) as e.g. "10 Jul 2026", with a fallback dash.
 * Formats from UTC parts (not `toLocaleDateString`) so the server (UTC) and
 * the client (the viewer's timezone) produce identical output — otherwise the
 * SSR'd date can differ from the hydrated one and trigger a React hydration
 * mismatch.
 */
export function formatDate(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** Small helper to format an average score for display. */
export function fmtScore(n: number | null): string {
  return n == null ? "—" : n.toFixed(2)
}

/**
 * Amber "not ready yet" banner shown when a reviewer/partner opens an
 * appraisal whose earlier phase hasn't been submitted. Mirrors the reference.
 */
export function NotReadyBanner({
  phase,
}: {
  phase: "reviewer" | "partner"
}) {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <a
          href="/employee/appraisals"
          className="flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-primary"
        >
          <Icon name="arrow_back" className="text-lg" />
          Dashboard
        </a>
      </div>
      <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-white p-6 text-sm text-amber-800">
        <Icon name="hourglass_top" className="mt-0.5 shrink-0 text-xl text-amber-500" />
        <div>
          <strong>Not ready yet.</strong>{" "}
          {phase === "reviewer"
            ? "The employee's self-assessment is still in progress. You'll receive a notification once it's submitted and your evaluation can begin."
            : "The previous appraisal phases haven't been completed. You'll be notified once the reviewer submits their evaluation and your review can begin."}
        </div>
      </div>
    </div>
  )
}
