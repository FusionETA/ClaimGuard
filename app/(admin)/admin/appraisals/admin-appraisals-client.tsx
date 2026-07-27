"use client"

import type { Route } from "next"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"

import { cn } from "@/lib/utils"
import { createAppraisalsAction } from "./actions"
import {
  Icon,
  StatusBadge,
  formatDate,
  stageBadge,
} from "@/app/(employee)/employee/appraisals/_ui"
import {
  appraisalStages,
  appraisalTypeLabel,
  appraisalTypes,
  type AdminAppraisalDashboardData,
  type AdminEmployeeRow,
  type AppraisalStage,
  type AppraisalTemplateSummary,
  type AppraisalType,
} from "@/modules/appraisify/domain/models"

type Tab = "employees" | "history"

export function AdminAppraisalsClient({ data }: { data: AdminAppraisalDashboardData }) {
  const [tab, setTab] = useState<Tab>("employees")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dialogFor, setDialogFor] = useState<AdminEmployeeRow[] | null>(null)

  function openDialog(rows: AdminEmployeeRow[]) {
    if (rows.length) setDialogFor(rows)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Greeting + stats */}
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900">Appraisal Dashboard</h1>
          <p className="mt-0.5 text-sm text-slate-500">Manage appraisal cycles and question sets</p>
        </div>
        <div className="flex gap-4">
          <StatCard value={data.stats.active} label="Active" color="text-primary" />
          <StatCard value={data.stats.complete} label="Complete" color="text-emerald-500" />
        </div>
      </div>

      {/* Tabbed card */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col justify-between gap-3 border-b border-slate-100 bg-slate-50/50 px-6 py-3 sm:flex-row sm:items-center">
          <div className="flex gap-1">
            <AdminTab active={tab === "employees"} onClick={() => setTab("employees")} icon="group">
              Employees
            </AdminTab>
            <AdminTab active={tab === "history"} onClick={() => setTab("history")} icon="history">
              Appraisal History
            </AdminTab>
          </div>
          {tab === "employees" ? (
            <button
              onClick={() => openDialog(data.employees.filter((e) => selected.has(e.id)))}
              disabled={selected.size === 0}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-white shadow-sm shadow-primary/20 transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="play_arrow" className="text-lg" />
              <span className="hidden sm:inline">Start Appraisal</span>
            </button>
          ) : null}
        </div>

        {tab === "employees" ? (
          <EmployeesTab
            rows={data.employees}
            selected={selected}
            setSelected={setSelected}
            onStartOne={(row) => openDialog([row])}
          />
        ) : (
          <HistoryTab data={data} />
        )}

        {/* Selection bar */}
        {tab === "employees" && selected.size > 0 ? (
          <div className="flex items-center justify-between border-t border-primary/20 bg-primary/5 px-6 py-3">
            <span className="text-sm font-semibold text-primary">
              {selected.size} employee(s) selected
            </span>
            <button
              onClick={() => openDialog(data.employees.filter((e) => selected.has(e.id)))}
              className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-primary/90"
            >
              <Icon name="play_arrow" className="text-lg" />
              Start Appraisal for Selected
            </button>
          </div>
        ) : null}
      </div>

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
          iconClass="bg-slate-100 text-slate-500"
          title="Manage Question Sets"
          body="Edit, reorder, or archive the question sets your appraisals use."
          cta="Open Question Sets"
        />
      </div>

      {dialogFor ? (
        <StartAppraisalDialog
          employees={dialogFor}
          people={data.people}
          templates={data.templates}
          onClose={() => setDialogFor(null)}
          onDone={() => {
            setDialogFor(null)
            setSelected(new Set())
          }}
        />
      ) : null}
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
    <Link
      href={href as Route}
      className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-colors hover:border-primary"
    >
      <div className="flex items-start gap-4">
        <div
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-colors group-hover:bg-primary group-hover:text-white",
            iconClass,
          )}
        >
          <Icon name={icon} className="text-2xl" />
        </div>
        <div>
          <h4 className="mb-1 text-lg font-bold text-slate-900">{title}</h4>
          <p className="text-sm leading-relaxed text-slate-500">{body}</p>
          <span className="mt-3 inline-flex items-center gap-1 text-sm font-bold text-primary transition-transform group-hover:translate-x-1">
            {cta}
            <Icon name="arrow_forward" className="text-sm" />
          </span>
        </div>
      </div>
    </Link>
  )
}

function StatCard({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-center shadow-sm">
      <div className={cn("text-2xl font-black", color)}>{value}</div>
      <div className="mt-0.5 text-xs font-medium text-slate-500">{label}</div>
    </div>
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
  onStartOne,
}: {
  rows: AdminEmployeeRow[]
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onStartOne: (row: AdminEmployeeRow) => void
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
      <div className="border-b border-slate-100 bg-slate-50/30 px-6 py-3">
        <div className="relative w-full sm:w-64">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employees…"
            className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-4 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>
      <div className="max-h-[460px] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-white">
            <tr className="border-b border-slate-100 bg-slate-50/30 text-xs font-bold uppercase tracking-wider text-slate-400">
              <th className="w-10 px-4 py-3 text-left">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="rounded border-slate-300 text-primary focus:ring-primary"
                />
              </th>
              <th className="px-4 py-3 text-left">Employee</th>
              <th className="hidden px-4 py-3 text-left sm:table-cell">Position</th>
              <th className="hidden px-4 py-3 text-left lg:table-cell">Department</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="w-24 px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((r) => {
              const active = r.activeStage !== null
              return (
                <tr key={r.id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      disabled={active}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      className="rounded border-slate-300 text-primary focus:ring-primary disabled:opacity-40"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                        {r.initials}
                      </div>
                      <span className="font-semibold text-slate-800">{r.name}</span>
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 text-slate-600 sm:table-cell">{r.position}</td>
                  <td className="hidden px-4 py-3 text-slate-600 lg:table-cell">{r.department}</td>
                  <td className="px-4 py-3">
                    {r.activeStage !== null ? (
                      <StatusBadge stage={r.activeStage} />
                    ) : (
                      <span className="text-xs font-medium text-slate-400">No active cycle</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!active ? (
                      <button
                        onClick={() => onStartOne(r)}
                        className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                      >
                        Start
                        <Icon name="play_arrow" className="text-base" />
                      </button>
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
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/30 px-6 py-3">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[15px] text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employee…"
            className="w-44 rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs focus:border-primary focus:ring-2 focus:ring-primary"
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
      </div>
      <div className="max-h-[440px] overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-white">
            <tr className="border-b border-slate-100 bg-slate-50/30 text-xs font-bold uppercase tracking-wider text-slate-400">
              <th className="px-4 py-3 text-left">Employee</th>
              <th className="px-4 py-3 text-left">Cycle</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="hidden px-4 py-3 text-left sm:table-cell">Submitted</th>
              <th className="w-24 px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((h) => {
              return (
                <tr key={h.id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3 font-semibold text-slate-800">{h.employeeName}</td>
                  <td className="px-4 py-3 text-slate-600">{h.cycleLabel}</td>
                  <td className="px-4 py-3">
                    <StatusBadge stage={h.stage} />
                  </td>
                  <td className="hidden px-4 py-3 text-slate-500 sm:table-cell">{formatDate(h.submittedAt)}</td>
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

function StartAppraisalDialog({
  employees,
  people,
  templates,
  onClose,
  onDone,
}: {
  employees: AdminEmployeeRow[]
  people: { id: string; name: string }[]
  templates: AppraisalTemplateSummary[]
  onClose: () => void
  onDone: () => void
}) {
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)
  const [type, setType] = useState<AppraisalType>("ANNUAL")
  const [reviewerId, setReviewerId] = useState("")
  const [partnerId, setPartnerId] = useState("")
  const [templateId, setTemplateId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const canSubmit = reviewerId && partnerId && reviewerId !== partnerId

  async function submit() {
    setSubmitting(true)
    setError(null)
    const res = await createAppraisalsAction({
      employeeIds: employees.map((e) => e.id),
      reviewerId,
      partnerId,
      year,
      type,
      templateId: templateId || null,
    })
    if (res.ok) {
      router.refresh()
      onDone()
    } else {
      setError(res.message)
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <h3 className="text-lg font-bold text-slate-900">Start Appraisal</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <Icon name="close" className="text-xl" />
          </button>
        </div>
        <div className="space-y-4 px-6 py-5">
          <p className="text-sm text-slate-500">
            Starting a cycle for{" "}
            <span className="font-semibold text-slate-700">
              {employees.length === 1 ? employees[0]!.name : `${employees.length} employees`}
            </span>
            . Assign a reviewer and partner.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Year">
              <input
                type="number"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
              />
            </Field>
            <Field label="Type">
              <select
                value={type}
                onChange={(e) => setType(e.target.value as AppraisalType)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
              >
                {appraisalTypes.map((t) => (
                  <option key={t} value={t}>
                    {appraisalTypeLabel(t)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Reviewer">
            <select
              value={reviewerId}
              onChange={(e) => setReviewerId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
            >
              <option value="">Select reviewer…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Partner">
            <select
              value={partnerId}
              onChange={(e) => setPartnerId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
            >
              <option value="">Select partner…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          {reviewerId && partnerId && reviewerId === partnerId ? (
            <p className="text-xs text-red-500">Reviewer and partner must be different people.</p>
          ) : null}

          <Field label="Question set">
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
            >
              <option value="">Default question set</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.questionCount})
                </option>
              ))}
            </select>
          </Field>

          {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
        </div>
        <div className="flex gap-3 border-t border-slate-100 px-6 py-4">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl border border-slate-200 px-5 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? (
              <>
                <Icon name="sync" className="animate-spin text-lg" />
                Starting…
              </>
            ) : (
              <>
                <Icon name="play_arrow" className="text-lg" />
                Start Cycle
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {children}
    </div>
  )
}
