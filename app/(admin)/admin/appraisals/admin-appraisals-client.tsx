"use client"

import type { Route } from "next"
import Link from "next/link"
import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import {
  Icon,
  StatusBadge,
  formatDate,
  stageBadge,
} from "@/app/(employee)/employee/appraisals/_ui"
import {
  appraisalStages,
  type AdminAppraisalDashboardData,
  type AdminEmployeeRow,
  type AppraisalStage,
} from "@/modules/appraisify/domain/models"

type Tab = "employees" | "history"

/** Build the Start Appraisal page URL for one or more selected employees. */
function startAppraisalHref(employeeIds: string[]): Route {
  return `/admin/appraisals/start?employees=${employeeIds.join(",")}` as Route
}

export function AdminAppraisalsClient({ data }: { data: AdminAppraisalDashboardData }) {
  const [tab, setTab] = useState<Tab>("employees")
  const [selected, setSelected] = useState<Set<string>>(new Set())

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Greeting + stats */}
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div>
          <h1 className="text-2xl font-extrabold text-foreground">Appraisal Dashboard</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Manage appraisal cycles and question sets</p>
        </div>
        <div className="flex gap-4">
          <StatCard value={data.stats.active} label="Active" color="text-primary" />
          <StatCard value={data.stats.complete} label="Complete" color="text-emerald-500" />
        </div>
      </div>

      {/* Tabbed card */}
      <Card className="overflow-hidden">
        <div className="flex flex-col justify-between gap-3 border-b border-border/60 bg-surface-low/50 px-6 py-3 sm:flex-row sm:items-center">
          <div className="flex gap-1">
            <AdminTab active={tab === "employees"} onClick={() => setTab("employees")} icon="group">
              Employees
            </AdminTab>
            <AdminTab active={tab === "history"} onClick={() => setTab("history")} icon="history">
              Appraisal History
            </AdminTab>
          </div>
          {tab === "employees" ? (
            selected.size > 0 ? (
              <Button asChild size="sm" className="shrink-0">
                <Link href={startAppraisalHref([...selected])}>
                  <Icon name="play_arrow" className="text-lg" />
                  <span className="hidden sm:inline">Start Appraisal</span>
                </Link>
              </Button>
            ) : (
              <Button size="sm" disabled className="shrink-0">
                <Icon name="play_arrow" className="text-lg" />
                <span className="hidden sm:inline">Start Appraisal</span>
              </Button>
            )
          ) : null}
        </div>

        {tab === "employees" ? (
          <EmployeesTab rows={data.employees} selected={selected} setSelected={setSelected} />
        ) : (
          <HistoryTab data={data} />
        )}

        {/* Selection bar */}
        {tab === "employees" && selected.size > 0 ? (
          <div className="flex items-center justify-between border-t border-primary/20 bg-primary/5 px-6 py-3">
            <span className="text-sm font-semibold text-primary">
              {selected.size} employee(s) selected
            </span>
            <Button asChild size="sm">
              <Link href={startAppraisalHref([...selected])}>
                <Icon name="play_arrow" className="text-lg" />
                Start Appraisal for Selected
              </Link>
            </Button>
          </div>
        ) : null}
      </Card>

      {/* Question management */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ManagementCard
          href="/admin/appraisals/templates/new"
          icon="add_circle"
          iconClass="bg-primary/10 text-primary"
          title="Question Builder"
          body="Create a new question set with sections, scoring questions, and guidance."
          cta="Open Builder"
        />
        <ManagementCard
          href="/admin/appraisals/templates"
          icon="edit_note"
          iconClass="bg-surface-low text-muted-foreground"
          title="Manage Question Sets"
          body="Edit, reorder, or archive the question sets your appraisals use."
          cta="Open Question Sets"
        />
      </div>
    </div>
  )
}

function ManagementCard({
  href,
  icon,
  iconClass,
  title,
  body,
  cta,
}: {
  href: string
  icon: string
  iconClass: string
  title: string
  body: string
  cta: string
}) {
  return (
    <Link href={href as Route} className="group block">
      <Card className="p-6 transition-colors hover:border-primary/60">
        <div className="flex items-start gap-4">
          <div
            className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-colors group-hover:bg-primary group-hover:text-primary-foreground",
              iconClass,
            )}
          >
            <Icon name={icon} className="text-2xl" />
          </div>
          <div>
            <h4 className="mb-1 text-lg font-bold text-foreground">{title}</h4>
            <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
            <span className="mt-3 inline-flex items-center gap-1 text-sm font-bold text-primary transition-transform group-hover:translate-x-1">
              {cta}
              <Icon name="arrow_forward" className="text-sm" />
            </span>
          </div>
        </div>
      </Card>
    </Link>
  )
}

function StatCard({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <Card className="px-5 py-3 text-center">
      <div className={cn("text-2xl font-black", color)}>{value}</div>
      <div className="mt-0.5 text-xs font-medium text-muted-foreground">{label}</div>
    </Card>
  )
}

function AdminTab({
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
        "rounded-lg border px-4 py-2 text-sm font-semibold transition-colors",
        active
          ? "border-primary/50 bg-primary/5 text-primary"
          : "border-transparent text-muted-foreground hover:bg-muted/50",
      )}
    >
      <Icon name={icon} className="mr-1 align-middle text-sm" style={{ fontSize: 16 }} />
      {children}
    </button>
  )
}

function EmployeesTab({
  rows,
  selected,
  setSelected,
}: {
  rows: AdminEmployeeRow[]
  selected: Set<string>
  setSelected: (s: Set<string>) => void
}) {
  const [search, setSearch] = useState("")
  const filtered = useMemo(
    () => rows.filter((r) => r.name.toLowerCase().includes(search.toLowerCase())),
    [rows, search],
  )
  // Only employees without an active cycle are selectable.
  const selectable = filtered.filter((r) => r.activeStage === null)
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id))

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  function toggleAll() {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(selectable.map((r) => r.id)))
  }

  return (
    <div>
      <div className="border-b border-border/60 bg-surface-low/40 px-6 py-3">
        <div className="relative w-full sm:w-64">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employees…"
            className="w-full rounded-lg border border-border/80 bg-card py-2 pl-9 pr-4 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>
      <div className="max-h-[460px] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border/60 bg-surface-low/40 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              <th className="w-10 px-4 py-3 text-left">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="rounded border-border text-primary focus:ring-primary"
                />
              </th>
              <th className="px-4 py-3 text-left">Employee</th>
              <th className="hidden px-4 py-3 text-left sm:table-cell">Position</th>
              <th className="hidden px-4 py-3 text-left lg:table-cell">Department</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="w-24 px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {filtered.map((r) => {
              const active = r.activeStage !== null
              return (
                <tr key={r.id} className="hover:bg-surface-low/50">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      disabled={active}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      className="rounded border-border text-primary focus:ring-primary disabled:opacity-40"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                        {r.initials}
                      </div>
                      <span className="font-semibold text-foreground">{r.name}</span>
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{r.position}</td>
                  <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">{r.department}</td>
                  <td className="px-4 py-3">
                    {r.activeStage !== null ? (
                      <StatusBadge stage={r.activeStage} />
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground">No active cycle</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!active ? (
                      <Link
                        href={startAppraisalHref([r.id])}
                        className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                      >
                        Start
                        <Icon name="play_arrow" className="text-base" />
                      </Link>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function HistoryTab({ data }: { data: AdminAppraisalDashboardData }) {
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<AppraisalStage | "">("")
  const filtered = useMemo(
    () =>
      data.history.filter((h) => {
        if (search && !h.employeeName.toLowerCase().includes(search.toLowerCase())) return false
        if (status && h.stage !== status) return false
        return true
      }),
    [data.history, search, status],
  )
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-surface-low/40 px-6 py-3">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employee…"
            className="w-44 rounded-lg border border-border/80 bg-card py-1.5 pl-8 pr-3 text-xs focus:border-primary focus:ring-2 focus:ring-primary"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as AppraisalStage | "")}
          className="rounded-lg border border-border/80 bg-card px-3 py-1.5 text-xs text-muted-foreground focus:ring-2 focus:ring-primary"
        >
          <option value="">All Statuses</option>
          {appraisalStages.map((s) => (
            <option key={s} value={s}>
              {stageBadge(s).label}
            </option>
          ))}
        </select>
      </div>
      <div className="max-h-[440px] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border/60 bg-surface-low/40 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 text-left">Employee</th>
              <th className="px-4 py-3 text-left">Cycle</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="hidden px-4 py-3 text-left sm:table-cell">Submitted</th>
              <th className="w-24 px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {filtered.map((h) => {
              return (
                <tr key={h.id} className="hover:bg-surface-low/50">
                  <td className="px-4 py-3 font-semibold text-foreground">{h.employeeName}</td>
                  <td className="px-4 py-3 text-muted-foreground">{h.cycleLabel}</td>
                  <td className="px-4 py-3">
                    <StatusBadge stage={h.stage} />
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{formatDate(h.submittedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/appraisals/${h.id}` as Route} className="text-sm font-semibold text-primary hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
