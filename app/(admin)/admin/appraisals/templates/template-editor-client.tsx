"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import { Icon } from "@/app/(employee)/employee/appraisals/_ui"
import type { AppraisalTemplateView } from "@/modules/appraisify/domain/models"

import { saveTemplateAction } from "./actions"

type EditableQuestion = {
  key: string
  section: string // "" = no section
  text: string
  description: string
}

export function TemplateEditorClient({
  template,
}: {
  template: AppraisalTemplateView | null
}) {
  const router = useRouter()
  const keySeq = useRef(0)
  const nextKey = () => `q${keySeq.current++}`

  const [name, setName] = useState(template?.name ?? "")
  const [questions, setQuestions] = useState<EditableQuestion[]>(() =>
    (template?.questions ?? []).map((q) => ({
      key: nextKey(),
      section: q.section ?? "",
      text: q.text,
      description: q.description ?? "",
    })),
  )
  const [sections, setSections] = useState<string[]>(() =>
    Array.from(new Set((template?.questions ?? []).map((q) => q.section).filter((s): s is string => !!s))),
  )

  // Left "compose" form.
  const [formSection, setFormSection] = useState("")
  const [formText, setFormText] = useState("")
  const [formDesc, setFormDesc] = useState("")
  const [newSection, setNewSection] = useState("")
  const [editingKey, setEditingKey] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canAdd = formText.trim().length > 0
  const canSave = name.trim().length > 0 && questions.length > 0

  function resetForm() {
    setFormText("")
    setFormDesc("")
    setEditingKey(null)
  }

  function createSection() {
    const s = newSection.trim()
    if (!s) return
    if (!sections.includes(s)) setSections((p) => [...p, s])
    setFormSection(s)
    setNewSection("")
  }

  function submitForm() {
    if (!canAdd) return
    if (editingKey) {
      setQuestions((p) =>
        p.map((q) =>
          q.key === editingKey ? { ...q, section: formSection, text: formText.trim(), description: formDesc.trim() } : q,
        ),
      )
    } else {
      setQuestions((p) => [
        ...p,
        { key: nextKey(), section: formSection, text: formText.trim(), description: formDesc.trim() },
      ])
    }
    resetForm()
  }

  function editQuestion(q: EditableQuestion) {
    setEditingKey(q.key)
    setFormSection(q.section)
    setFormText(q.text)
    setFormDesc(q.description)
  }

  function removeQuestion(key: string) {
    setQuestions((p) => p.filter((q) => q.key !== key))
    if (editingKey === key) resetForm()
  }

  function move(key: string, dir: -1 | 1) {
    setQuestions((p) => {
      const i = p.findIndex((q) => q.key === key)
      const j = i + dir
      if (i < 0 || j < 0 || j >= p.length) return p
      const next = [...p]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })
  }

  async function save() {
    setError(null)
    setSaving(true)
    const res = await saveTemplateAction({
      id: template?.id ?? null,
      name: name.trim(),
      questions: questions.map((q) => ({
        section: q.section.trim() || null,
        text: q.text.trim(),
        description: q.description.trim() || null,
      })),
    })
    if (res.ok) {
      router.push("/admin/appraisals/templates")
      router.refresh()
    } else {
      setError(res.message)
      setSaving(false)
    }
  }

  const sectionOptions = useMemo(() => sections, [sections])

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-28">
      {/* Sub-header */}
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/admin/appraisals/templates"
          className="flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-primary"
        >
          <Icon name="arrow_back" className="text-lg" />
          Question Sets
        </Link>
        <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-bold text-primary">
          {template ? "Edit template" : "New template"}
        </span>
      </div>

      {/* Name */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-500">
          Template name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Engineering Annual Review"
          className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-semibold focus:border-primary focus:ring-2 focus:ring-primary"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
        {/* Left: compose form */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="mb-5 flex items-center gap-2 font-bold text-slate-900">
              <Icon name={editingKey ? "edit" : "add_circle"} className="text-primary text-xl" />
              {editingKey ? "Edit question" : "New question"}
            </h3>

            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-600">Section</label>
                <select
                  value={formSection}
                  onChange={(e) => setFormSection(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
                >
                  <option value="">General (no section)</option>
                  {sectionOptions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-600">Create new section</label>
                <div className="flex gap-2">
                  <input
                    value={newSection}
                    onChange={(e) => setNewSection(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        createSection()
                      }
                    }}
                    placeholder="e.g. Technical Skills"
                    className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
                  />
                  <button
                    type="button"
                    onClick={createSection}
                    className="shrink-0 rounded-lg bg-primary/10 px-3 py-2 text-sm font-bold text-primary hover:bg-primary/20"
                  >
                    Add
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-600">
                  Question text <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={formText}
                  onChange={(e) => setFormText(e.target.value)}
                  rows={3}
                  placeholder="e.g. How effectively does the employee communicate with stakeholders?"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-600">Description (optional)</label>
                <textarea
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  rows={2}
                  placeholder="Guidance on how to score this question…"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-primary focus:ring-2 focus:ring-primary"
                />
              </div>

              <div className="flex gap-2">
                <button
                  onClick={submitForm}
                  disabled={!canAdd}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Icon name={editingKey ? "check" : "add"} className="text-lg" />
                  {editingKey ? "Update question" : "Add to list"}
                </button>
                {editingKey ? (
                  <button
                    onClick={resetForm}
                    className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* Right: question list */}
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-slate-100 px-6 py-4">
            <h3 className="flex items-center gap-2 font-bold text-slate-900">
              <Icon name="format_list_numbered" className="text-primary text-lg" />
              Question set
            </h3>
            <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">
              {questions.length}
            </span>
          </div>

          {questions.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-slate-400">
              No questions yet. Add questions using the form on the left.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {questions.map((q, i) => (
                <div
                  key={q.key}
                  className={cn(
                    "flex items-start gap-3 px-5 py-4",
                    editingKey === q.key && "bg-primary/5",
                  )}
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-bold text-slate-500">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {q.section ? (
                      <span className="mb-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                        {q.section}
                      </span>
                    ) : null}
                    <p className="text-sm font-medium text-slate-800">{q.text}</p>
                    {q.description ? <p className="mt-0.5 text-xs text-slate-400">{q.description}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconBtn name="arrow_upward" disabled={i === 0} onClick={() => move(q.key, -1)} label="Move up" />
                    <IconBtn name="arrow_downward" disabled={i === questions.length - 1} onClick={() => move(q.key, 1)} label="Move down" />
                    <IconBtn name="edit" onClick={() => editQuestion(q)} label="Edit" />
                    <IconBtn name="delete" onClick={() => removeQuestion(q.key)} label="Delete" danger />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="action-bar">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4">
          <div className="min-w-0 text-sm text-slate-500">
            {error ? <span className="font-medium text-red-600">{error}</span> : `${questions.length} question${questions.length === 1 ? "" : "s"}`}
          </div>
          <button
            onClick={save}
            disabled={!canSave || saving}
            className="flex items-center gap-2 rounded-xl bg-primary px-7 py-2.5 text-sm font-bold text-white shadow-sm shadow-primary/30 transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name={saving ? "sync" : "save"} className={cn("text-lg", saving && "animate-spin")} />
            {saving ? "Saving…" : "Save template"}
          </button>
        </div>
      </div>
    </div>
  )
}

function IconBtn({
  name,
  onClick,
  disabled,
  label,
  danger,
}: {
  name: string
  onClick: () => void
  disabled?: boolean
  label: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent",
        danger ? "hover:text-red-600" : "hover:text-primary",
      )}
    >
      <Icon name={name} className="text-lg" />
    </button>
  )
}
