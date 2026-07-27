"use client"

import Link from "next/link"
import { useMemo, useState } from "react"

import { cn } from "@/lib/utils"
import {
  appraisalStages,
  type AppraisalListItem,
  type AppraisalStage,
  type EmployeeAppraisalDashboardData,
} from "@/modules/appraisify/domain/models"

import {
  Icon,
  Skel,
  StatusBadge,
  fmtScore,
  formatDate,
  stageBadge,
  useSimulatedLoad,
} from "./_ui"

type Tab = "overview" | "history"

export function AppraisalsPageClient({
  data,
}: {
  data: EmployeeAppraisalDashboardData
}) {
  const [tab, setTab] = useState<Tab>("overview")
  const loading = useSimulatedLoad()

  // Everything awaiting the viewer's action across all three roles
  // (own self-assessment, reviewer scoring, partner scoring).
  const pending = data.history.filter((it) => it.viewerCanAct)

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">My Appraisal</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Your current performance review cycle
          </p>
        </div>
      </div>

      {pending.length > 0 ? <PendingActions items={pending} /> : null}

      {/* Tabbed card */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-1 border-b border-slate-100 px-4 pt-3">
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon="person">
            Overview
          </TabButton>
          <TabButton active={tab === "history"} onClick={() => setTab("history")} icon="history">
            History
          </TabButton>
        </div>

        {tab === "overview" ? (
          <OverviewTab data={data} loading={loading} />
        ) : (
          <HistoryTab items={data.history} loading={loading} />
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors",
        active
          ? "border-primary text-primary"
          : "border-transparent text-slate-500 hover:text-slate-700",
      )}
    >
      <Icon name={icon} className="text-base" />
      {children}
    </button>
  )
}

// Per-role presentation for a pending row.
function pendingRowMeta(it: AppraisalListItem): {
  title: string
  roleLabel: string
  roleClass: string
  cta: string
} {
  if (it.viewerPhase === "reviewee") {
    return {
      title: "Your self-assessment",
      roleLabel: "Self-assessment",
      roleClass: "bg-amber-100 text-amber-700",
      cta: "Start self-assessment",
    }
  }
  if (it.viewerPhase === "reviewer") {
    return {
      title: it.revieweeName,
      roleLabel: "Reviewer",
      roleClass: "bg-emerald-100 text-emerald-700",
      cta: "Review now",
    }
  }
  return {
    title: it.revieweeName,
    roleLabel: "Partner",
    roleClass: "bg-purple-100 text-purple-700",
    cta: "Review now",
  }
}

function PendingActions({ items }: { items: AppraisalListItem[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-primary/20 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-primary/10 bg-primary/5 px-5 py-3">
        <Icon name="pending_actions" className="text-lg text-primary" />
        <h2 className="text-sm font-bold text-primary">Pending your action</h2>
        <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-white">
          {items.length}
        </span>
      </div>
      <div className="divide-y divide-slate-100">
        {items.map((it) => {
          const meta = pendingRowMeta(it)
          return (
            <div key={it.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate font-semibold text-slate-800">{meta.title}</p>
                  <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", meta.roleClass)}>
                    {meta.roleLabel}
                  </span>
                </div>
                <p className="truncate text-xs text-slate-500">
                  {it.cycleLabel} · <span className="font-mono">{it.referenceNumber}</span>
                </p>
              </div>
              <Link
                href={`/employee/appraisals/${it.id}`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-white shadow-sm shadow-primary/30 transition-colors hover:bg-primary/90"
              >
                <Icon name="arrow_forward" className="text-base" />
                {meta.cta}
              </Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function OverviewTab({
  data,
  loading,
}: {
  data: EmployeeAppraisalDashboardData
  loading: boolean
}) {
  const current = data.current
  if (!current) {
    return (
      <div className="p-10 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-100">
          <Icon name="assignment" className="text-3xl text-slate-400" />
        </div>
        <h3 className="text-lg font-bold text-slate-900">No active appraisal</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
          You don&apos;t have an appraisal in progress right now. When a cycle is
          started for you, it will appear here.
        </p>
      </div>
    )
  }

  const { item, role, team, scores } = current
  const complete = item.stage === "SUBMITTED"

  return (
    <div>
      {/* Status row */}
      <div className="flex flex-col justify-between gap-6 border-b border-slate-100 p-6 md:flex-row md:items-center">
        <div className="flex items-center gap-5">
          <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-primary/10 text-2xl font-black text-primary">
            {loading ? <Skel w={28} className="!h-7" /> : data.viewer.initials}
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900">
              {loading ? <Skel w={140} /> : data.viewer.name}
            </h2>
            <p className="text-sm text-slate-500">
              {loading ? <Skel w={180} /> : [role, team].filter(Boolean).join(" · ") || "—"}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-bold text-primary">
                {loading ? <Skel w={90} className="!h-3" /> : item.cycleLabel}
              </span>
              <StatusBadge stage={item.stage} />
            </div>
          </div>
        </div>

        {/* Actions live in the "Pending your action" list above; the Overview
            is a status display (matches the reference). Only the completed-cycle
            PDF download surfaces here. */}
        {complete ? (
          <div className="flex flex-wrap gap-3">
            <button className="flex items-center gap-2 rounded-lg border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50">
              <Icon name="download" className="text-lg" />
              Download PDF
            </button>
          </div>
        ) : null}
      </div>

      {/* Score cards — shown once the full cycle is complete */}
      {complete ? (
        <div className="grid grid-cols-1 gap-4 p-6 md:grid-cols-3">
          <ScoreCard label="My Score" icon="person" score={scores.self} accent="text-primary bg-primary/10" bar="bg-primary" loading={loading} />
          <ScoreCard label="Reviewer Score" icon="visibility" score={scores.reviewer} accent="text-indigo-500 bg-indigo-500/10" bar="bg-indigo-500" loading={loading} />
          <ScoreCard label="Partner Score" icon="handshake" score={scores.partner} accent="text-emerald-500 bg-emerald-500/10" bar="bg-emerald-500" loading={loading} />
        </div>
      ) : null}
    </div>
  )
}

function ScoreCard({
  label,
  icon,
  score,
  accent,
  bar,
  loading,
}: {
  label: string
  icon: string
  score: number | null
  accent: string
  bar: string
  loading: boolean
}) {
  const pct = score == null ? 0 : (score / 5) * 100
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
      <div className="mb-3 flex items-start justify-between">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
          {label}
        </p>
        <Icon name={icon} className={cn("rounded-lg p-1.5 text-lg", accent)} />
      </div>
      <div className="mb-3 text-3xl font-black text-slate-900">
        {loading ? <Skel w={48} className="!h-7" /> : fmtScore(score)}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={cn("h-full rounded-full", bar)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function HistoryTab({
  items,
  loading,
}: {
  items: AppraisalListItem[]
  loading: boolean
}) {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<AppraisalStage | "">("")
  const [role, setRole] = useState<AppraisalListItem["viewerPhase"] | "">("")

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (search && !it.cycleLabel.toLowerCase().includes(search.toLowerCase())) return false
      if (status && it.stage !== status) return false
      if (role && it.viewerPhase !== role) return false
      return true
    })
  }, [items, search, status, role])

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/30 px-6 py-3">
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-slate-400"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            type="text"
            placeholder="Search cycle…"
            className="w-36 rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs focus:border-primary focus:ring-2 focus:ring-primary"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as AppraisalStage | "")}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 focus:ring-2 focus:ring-primary"
        >
          <option value="">All Statuses</option>
          {appraisalStages.map((s) => (
            <option key={s} value={s}>
              {stageBadge(s).label}
            </option>
          ))}
        </select>
        <select
          value={role ?? ""}
          onChange={(e) =>
            setRole(e.target.value as AppraisalListItem["viewerPhase"] | "")
          }
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 focus:ring-2 focus:ring-primary"
        >
          <option value="">All Roles</option>
          <option value="reviewee">Self</option>
          <option value="reviewer">Reviewer</option>
          <option value="partner">Partner</option>
        </select>
      </div>

      {/* Table */}
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-white">
            <tr className="border-b border-slate-100 bg-slate-50/30 text-xs font-bold uppercase tracking-wider text-slate-400">
              <th className="px-4 py-3 text-left">Cycle</th>
              <th className="px-4 py-3 text-left">Your Role</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="hidden px-4 py-3 text-left sm:table-cell">Submitted</th>
              <th className="w-28 px-4 py-3 text-left" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              [0, 1, 2].map((i) => (
                <tr key={i}>
                  <td className="px-4 py-4"><Skel w={120} /></td>
                  <td className="px-4 py-4"><Skel w={60} /></td>
                  <td className="px-4 py-4"><Skel w={90} /></td>
                  <td className="hidden px-4 py-4 sm:table-cell"><Skel w={80} /></td>
                  <td className="px-4 py-4"><Skel w={50} /></td>
                </tr>
              ))
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-10 text-center text-sm text-slate-400">
                  No appraisals match your filters.
                </td>
              </tr>
            ) : (
              filtered.map((it) => {
                return (
                  <tr key={it.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-4">
                      <p className="font-semibold text-slate-800">{it.cycleLabel}</p>
                      <p className="font-mono text-xs text-slate-400">{it.referenceNumber}</p>
                    </td>
                    <td className="px-4 py-4 capitalize text-slate-600">
                      {it.viewerPhase === "reviewee" ? "Self" : it.viewerPhase ?? "—"}
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge stage={it.stage} />
                    </td>
                    <td className="hidden px-4 py-4 text-slate-500 sm:table-cell">
                      {formatDate(it.submittedAt)}
                    </td>
                    <td className="px-4 py-4">
                      <Link
                        href={`/employee/appraisals/${it.id}`}
                        className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                      >
                        {it.viewerCanAct ? "Continue" : "View"}
                        <Icon name="chevron_right" className="text-base" />
                      </Link>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
