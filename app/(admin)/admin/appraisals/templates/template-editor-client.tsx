"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { Icon } from "@/app/(employee)/employee/appraisals/_ui"
import { toTemplateQuestionInput, type AiSuggestedQuestion, type AppraisalTemplateView } from "@/modules/appraisify/domain/models"

import { saveTemplateAction } from "./actions"
import { AiAssistPanel } from "./ai-assist-panel"
import { ImproveQuestionModal } from "./improve-question-modal"

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

  const [aiAssistOpen, setAiAssistOpen] = useState(false)
  const [improvingKey, setImprovingKey] = useState<string | null>(null)
  const improvingQuestion = questions.find((q) => q.key === improvingKey) ?? null

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

  function addAiQuestion(q: AiSuggestedQuestion) {
    const input = toTemplateQuestionInput(q)
    setQuestions((p) => [
      ...p,
      { key: nextKey(), section: input.section ?? "", text: input.text, description: input.description ?? "" },
    ])
    if (input.section && !sections.includes(input.section)) {
      setSections((p) => [...p, input.section!])
    }
  }

  function addAllAiQuestions(qs: AiSuggestedQuestion[]) {
    qs.forEach(addAiQuestion)
  }

  function useImprovedVersion(key: string, q: AiSuggestedQuestion) {
    const input = toTemplateQuestionInput(q)
    setQuestions((p) =>
      p.map((row) =>
        row.key === key
          ? { ...row, section: input.section ?? "", text: input.text, description: input.description ?? "" }
          : row,
      ),
    )
    if (input.section && !sections.includes(input.section)) {
      setSections((p) => [...p, input.section!])
    }
    setImprovingKey(null)
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
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary"
        >
          <Icon name="arrow_back" className="text-lg" />
          Question Sets
        </Link>
        <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-bold text-primary">
          {template ? "Edit template" : "New template"}
        </span>
      </div>

      {/* Name */}
      <Card className="p-5">
        <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Template name
        </Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Engineering Annual Review"
          className="font-semibold"
        />
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
        {/* Left: compose form */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <Card className="p-6">
            <h3 className="mb-5 flex items-center gap-2 font-bold text-foreground">
              <Icon name={editingKey ? "edit" : "add_circle"} className="text-primary text-xl" />
              {editingKey ? "Edit question" : "New question"}
            </h3>

            <div className="space-y-4">
              <div>
                <Label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Section</Label>
                <select
                  value={formSection}
                  onChange={(e) => setFormSection(e.target.value)}
                  className="flex h-12 w-full items-center rounded-2xl border border-border/80 bg-card px-4 text-sm text-foreground shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
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
                <Label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Create new section</Label>
                <div className="flex gap-2">
                  <Input
                    value={newSection}
                    onChange={(e) => setNewSection(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        createSection()
                      }
                    }}
                    placeholder="e.g. Technical Skills"
                    className="min-w-0 flex-1"
                  />
                  <Button type="button" variant="secondary" onClick={createSection} className="shrink-0">
                    Add
                  </Button>
                </div>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                  Question text <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  value={formText}
                  onChange={(e) => setFormText(e.target.value)}
                  rows={3}
                  placeholder="e.g. How effectively does the employee communicate with stakeholders?"
                />
              </div>

              <div>
                <Label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Description (optional)</Label>
                <Textarea
                  value={formDesc}
                  onChange={(e) => setFormDesc(e.target.value)}
                  rows={2}
                  placeholder="Guidance on how to score this question…"
                />
              </div>

              <div className="flex gap-2">
                <Button onClick={submitForm} disabled={!canAdd} className="flex-1">
                  <Icon name={editingKey ? "check" : "add"} className="text-lg" />
                  {editingKey ? "Update question" : "Add to list"}
                </Button>
                {editingKey ? (
                  <Button variant="outline" onClick={resetForm}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>
        </div>

        {/* Right: question list */}
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border/60 px-6 py-4">
            <h3 className="flex items-center gap-2 font-bold text-foreground">
              <Icon name="format_list_numbered" className="text-primary text-lg" />
              Question set
            </h3>
            <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">
              {questions.length}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100"
              onClick={() => setAiAssistOpen(true)}
            >
              <span aria-hidden>✨</span> AI Assist
            </Button>
          </div>

          {questions.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              No questions yet. Add questions using the form on the left.
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {questions.map((q, i) => (
                <div
                  key={q.key}
                  className={cn(
                    "flex items-start gap-3 px-5 py-4",
                    editingKey === q.key && "bg-primary/5",
                  )}
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-low text-xs font-bold text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {q.section ? (
                      <span className="mb-1 inline-block rounded-full bg-surface-low px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        {q.section}
                      </span>
                    ) : null}
                    <p className="text-sm font-medium text-foreground">{q.text}</p>
                    {q.description ? <p className="mt-0.5 text-xs text-muted-foreground">{q.description}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconBtn name="arrow_upward" disabled={i === 0} onClick={() => move(q.key, -1)} label="Move up" />
                    <IconBtn name="arrow_downward" disabled={i === questions.length - 1} onClick={() => move(q.key, 1)} label="Move down" />
                    <IconBtn name="edit" onClick={() => editQuestion(q)} label="Edit" />
                    <IconBtn name="auto_awesome" onClick={() => setImprovingKey(q.key)} label="Improve with AI" />
                    <IconBtn name="delete" onClick={() => removeQuestion(q.key)} label="Delete" danger />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Action bar */}
      <div className="action-bar">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4">
          <div className="min-w-0 text-sm text-muted-foreground">
            {error ? <span className="font-medium text-destructive">{error}</span> : `${questions.length} question${questions.length === 1 ? "" : "s"}`}
          </div>
          <Button onClick={save} disabled={!canSave || saving}>
            <Icon name={saving ? "sync" : "save"} className={cn("text-lg", saving && "animate-spin")} />
            {saving ? "Saving…" : "Save template"}
          </Button>
        </div>
      </div>

      <AiAssistPanel
        open={aiAssistOpen}
        onOpenChange={setAiAssistOpen}
        templateName={name}
        existingSections={sections}
        onAddQuestion={addAiQuestion}
        onAddAll={addAllAiQuestions}
      />
      <ImproveQuestionModal
        question={improvingQuestion}
        open={improvingKey !== null}
        onOpenChange={(open) => {
          if (!open) setImprovingKey(null)
        }}
        onUseVersion={(q) => {
          if (improvingKey) useImprovedVersion(improvingKey, q)
        }}
      />
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
        "flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-low disabled:opacity-30 disabled:hover:bg-transparent",
        danger ? "hover:text-destructive" : "hover:text-primary",
      )}
    >
      <Icon name={name} className="text-lg" />
    </button>
  )
}
