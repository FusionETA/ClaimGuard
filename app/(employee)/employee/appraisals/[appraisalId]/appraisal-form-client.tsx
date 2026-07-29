"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import {
  appraisalPhases,
  confirmPhaseParam,
  phaseLabel,
  type AppraisalPhase,
  type AppraisalQuestionView,
  type AppraisalRecord,
} from "@/modules/appraisify/domain/models"
import type { SubmitPhaseInput } from "@/modules/appraisify/application/services/appraisal-workflow.service"

import { Icon, PHASE_ACCENT, Skel, fmtScore, useSimulatedLoad } from "../_ui"
import { submitAppraisalPhaseAction } from "./actions"

/* ── helpers ─────────────────────────────────────────────────────── */

const PHASE_INDEX: Record<AppraisalPhase, number> = {
  reviewee: 0,
  reviewer: 1,
  partner: 2,
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section"
}

function phaseScore(q: AppraisalQuestionView, phase: AppraisalPhase): number | null {
  return phase === "reviewee" ? q.revieweeScore : phase === "reviewer" ? q.reviewerScore : q.partnerScore
}
function phaseComment(q: AppraisalQuestionView, phase: AppraisalPhase): string | null {
  return phase === "reviewee" ? q.revieweeComment : phase === "reviewer" ? q.reviewerComment : q.partnerComment
}

type Section = { id: string; title: string; questions: AppraisalQuestionView[] }

function groupSections(questions: AppraisalQuestionView[]): Section[] {
  const map = new Map<string, AppraisalQuestionView[]>()
  for (const q of questions) {
    const key = q.section || "General"
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(q)
  }
  return [...map.entries()].map(([title, qs]) => ({ id: slug(title), title, questions: qs }))
}

/* ── component ───────────────────────────────────────────────────── */

export function AppraisalFormClient({
  record,
  phase,
}: {
  record: AppraisalRecord
  phase: AppraisalPhase
}) {
  const accent = PHASE_ACCENT[phase]
  const loading = useSimulatedLoad()
  const sections = useMemo(() => groupSections(record.questions), [record.questions])

  // Editable-phase local state (drafts), seeded from any saved values.
  const [scores, setScores] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      record.questions.map((q) => {
        const s = phaseScore(q, phase)
        return [q.id, s == null ? "" : String(s)]
      }),
    ),
  )
  const [comments, setComments] = useState<Record<string, string>>(() =>
    Object.fromEntries(record.questions.map((q) => [q.id, phaseComment(q, phase) ?? ""])),
  )
  const sectionText =
    phase === "reviewee" ? record.revieweeSection : phase === "reviewer" ? record.reviewerSection : record.partnerSection
  const [summary, setSummary] = useState({
    goals: sectionText.goals ?? "",
    remarks: sectionText.remarks ?? "",
    development: sectionText.development ?? "",
  })

  const [activeSection, setActiveSection] = useState<string>("all")
  const [modal, setModal] = useState<"hidden" | "confirm" | "submitting" | "done">("hidden")
  const [error, setError] = useState<string | null>(null)
  const [draftState, setDraftState] = useState<"idle" | "saving" | "saved">("idle")
  const router = useRouter()

  const total = record.questions.length
  const answered = Object.values(scores).filter((v) => v.trim() !== "" && !Number.isNaN(Number(v))).length
  const avg = useMemo(() => {
    const nums = Object.values(scores)
      .map((v) => Number(v))
      .filter((n) => v_ok(n))
    if (!nums.length) return null
    return nums.reduce((a, b) => a + b, 0) / nums.length
  }, [scores])

  function setScore(id: string, v: string) {
    setScores((p) => ({ ...p, [id]: v }))
  }
  function setComment(id: string, v: string) {
    setComments((p) => ({ ...p, [id]: v }))
  }

  function buildInput(submit: boolean): SubmitPhaseInput {
    return {
      appraisalId: record.id,
      phase,
      submit,
      questions: record.questions.map((q) => {
        const raw = scores[q.id] ?? ""
        const n = Number(raw)
        return {
          questionId: q.id,
          score: raw.trim() !== "" && Number.isFinite(n) ? n : null,
          comment: (comments[q.id] ?? "").trim() || null,
        }
      }),
      section: {
        goals: summary.goals.trim() || null,
        remarks: summary.remarks.trim() || null,
        development: summary.development.trim() || null,
      },
    }
  }

  async function doSubmit() {
    setError(null)
    setModal("submitting")
    const res = await submitAppraisalPhaseAction(buildInput(true))
    if (res.ok) {
      router.push(`/employee/appraisals/${record.id}/confirm?phase=${confirmPhaseParam(phase)}`)
    } else {
      setError(res.message)
      setModal("confirm")
    }
  }

  async function saveDraft() {
    setDraftState("saving")
    const res = await submitAppraisalPhaseAction(buildInput(false))
    setDraftState(res.ok ? "saved" : "idle")
    if (!res.ok) setError(res.message)
    else setTimeout(() => setDraftState("idle"), 2000)
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-28">
      {/* Sub-header */}
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/employee/appraisals"
          className="flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-primary"
        >
          <Icon name="arrow_back" className="text-lg" />
          Dashboard
        </Link>
        <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-bold", accent.pill)}>
          {phaseLabel(phase)} Phase
        </span>
      </div>

      {/* Phase banner (Reviewer 1 / Reviewer 2) */}
      {phase !== "reviewee" ? (
        <div className={cn("flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm", accent.bannerBg, accent.bannerText)}>
          <Icon name="info" className="text-base" />
          <span>
            <strong>{phaseLabel(phase)} Phase active.</strong>{" "}
            {phase === "reviewer"
              ? "The employee's self-assessment is visible for reference. Fill your own scores in the highlighted column."
              : "Self-assessment and Reviewer 1's scores are visible for reference. Add your scores in the highlighted column."}
          </span>
        </div>
      ) : null}

      {/* Metadata card */}
      <MetadataCard record={record} loading={loading} />

      {/* Progress bar */}
      <Card className="p-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Completion</span>
          <span className={cn("text-sm font-bold", phase === "reviewee" ? "text-amber-600" : phase === "reviewer" ? "text-emerald-600" : "text-purple-600")}>
            {answered} / {total} questions
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all duration-300", accent.progress)}
            style={{ width: `${total ? (answered / total) * 100 : 0}%` }}
          />
        </div>
      </Card>

      {/* Section tabs */}
      <div className="hide-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
        <SectionTab label="All" active={activeSection === "all"} accent={accent} onClick={() => setActiveSection("all")} />
        {sections.map((s) => (
          <SectionTab
            key={s.id}
            label={s.title}
            active={activeSection === s.id}
            accent={accent}
            onClick={() => setActiveSection(s.id)}
          />
        ))}
      </div>

      {/* Section blocks */}
      <div className="space-y-6">
        {sections
          .filter((s) => activeSection === "all" || s.id === activeSection)
          .map((section) => (
            <SectionBlock
              key={section.id}
              section={section}
              phase={phase}
              record={record}
              scores={scores}
              comments={comments}
              onScore={setScore}
              onComment={setComment}
            />
          ))}
      </div>

      {/* Summary card (Goals Review / Overall Remarks / Development Plans) */}
      <SummaryCard phase={phase} record={record} value={summary} onChange={setSummary} />

      {/* Action bar */}
      <div className="action-bar">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <Button variant="outline" onClick={saveDraft} disabled={draftState === "saving"}>
            <Icon
              name={draftState === "saved" ? "check" : "save"}
              className={cn("text-lg", draftState === "saving" && "animate-pulse")}
            />
            <span className="hidden sm:inline">
              {draftState === "saving" ? "Saving…" : draftState === "saved" ? "Saved" : "Save Draft"}
            </span>
          </Button>
          <div className="flex items-center gap-4">
            <div className="hidden text-center sm:block">
              <p className="text-xs text-muted-foreground">Avg Score</p>
              <p className={cn("text-xl font-black leading-none", phase === "reviewee" ? "text-amber-600" : phase === "reviewer" ? "text-emerald-600" : "text-purple-600")}>
                {fmtScore(avg)}
              </p>
            </div>
            <Button onClick={() => setModal("confirm")} className={accent.button}>
              <Icon name="send" className="text-lg" />
              Submit {phaseLabel(phase)}
            </Button>
          </div>
        </div>
      </div>

      {/* Submit modal */}
      {modal !== "hidden" ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <Card className="w-full max-w-md p-8 text-center">
            {modal === "submitting" ? (
              <>
                <div className={cn("mx-auto mb-4 flex h-16 w-16 animate-spin items-center justify-center rounded-full", phase === "reviewee" ? "bg-amber-100" : phase === "reviewer" ? "bg-emerald-100" : "bg-purple-100")}>
                  <Icon name="sync" className={cn("text-3xl", phase === "reviewee" ? "text-amber-600" : phase === "reviewer" ? "text-emerald-600" : "text-purple-600")} />
                </div>
                <h3 className="mb-2 text-xl font-extrabold text-foreground">Submitting…</h3>
                <p className="text-sm text-muted-foreground">
                  Please wait while your appraisal is being saved.
                  <br />
                  Do not close this window.
                </p>
              </>
            ) : (
              <>
                <div className={cn("mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full", phase === "reviewee" ? "bg-amber-100" : phase === "reviewer" ? "bg-emerald-100" : "bg-purple-100")}>
                  <Icon name="send" className={cn("text-3xl", phase === "reviewee" ? "text-amber-600" : phase === "reviewer" ? "text-emerald-600" : "text-purple-600")} />
                </div>
                <h3 className="mb-2 text-xl font-extrabold text-foreground">Submit {phaseLabel(phase)}?</h3>
                <p className="mb-6 text-sm text-muted-foreground">
                  Once submitted, you won&apos;t be able to edit your responses.
                  {phase === "reviewee"
                    ? " Reviewer 1 will be notified to begin their evaluation."
                    : phase === "reviewer"
                      ? " Reviewer 2 will be notified to begin their review."
                      : " The appraisal cycle will be marked complete."}
                </p>
                {error ? <p className="mb-3 text-sm font-medium text-destructive">{error}</p> : null}
                <div className="flex gap-3">
                  <Button variant="outline" className="flex-1" onClick={() => setModal("hidden")}>
                    Cancel
                  </Button>
                  <Button className={cn("flex-1", accent.button)} onClick={doSubmit}>
                    Yes, Submit
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  )
}

function v_ok(n: number) {
  return !Number.isNaN(n) && n >= 1 && n <= 5
}

/* ── sub-components ──────────────────────────────────────────────── */

function MetadataCard({ record, loading }: { record: AppraisalRecord; loading: boolean }) {
  const cells: Array<[string, React.ReactNode, number]> = [
    ["Reviewee", record.reviewee.name, 90],
    ["Reviewer 1", record.reviewer.name, 90],
    ["Reviewer 2", record.partner.name, 90],
    ["Year", record.year, 40],
    ["Team", record.team ?? "—", 72],
    ["Role", record.role ?? "—", 72],
    ["Ref#", record.referenceNumber, 80],
  ]
  return (
    <Card className="p-5">
      <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4 lg:grid-cols-7">
        {cells.map(([label, value, w]) => (
          <div key={label}>
            <p className="profile-label">{label}</p>
            <p className={cn("profile-value", label === "Ref#" && "font-mono text-xs")}>
              {loading ? <Skel w={w} /> : value}
            </p>
          </div>
        ))}
      </div>
    </Card>
  )
}

function SectionTab({
  label,
  active,
  accent,
  onClick,
}: {
  label: string
  active: boolean
  accent: (typeof PHASE_ACCENT)[AppraisalPhase]
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-full border px-4 py-1.5 text-sm font-semibold transition-colors",
        active ? accent.tabActive : cn("border-border/80 bg-card text-muted-foreground", accent.tabHover),
      )}
    >
      {label}
    </button>
  )
}

function SectionBlock({
  section,
  phase,
  record,
  scores,
  comments,
  onScore,
  onComment,
}: {
  section: Section
  phase: AppraisalPhase
  record: AppraisalRecord
  scores: Record<string, string>
  comments: Record<string, string>
  onScore: (id: string, v: string) => void
  onComment: (id: string, v: string) => void
}) {
  const accent = PHASE_ACCENT[phase]
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border/60 bg-surface-low/50 px-6 py-4">
        <h3 className="font-bold text-foreground">{section.title}</h3>
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-xs font-semibold uppercase tracking-wider text-slate-500">
              <th className="w-80 px-6 py-3 text-left">Question</th>
              {appraisalPhases.map((colPhase) => (
                <th
                  key={colPhase}
                  className={cn(
                    "w-28 px-4 py-3 text-center",
                    colPhase === phase ? accent.headBg : "bg-slate-50/80 text-slate-400",
                  )}
                >
                  {colPhase === phase ? (
                    <span className="inline-flex items-center gap-1">
                      <Icon name="edit" className="text-sm" /> {PHASE_ACCENT[colPhase].columnLabel}
                    </span>
                  ) : (
                    PHASE_ACCENT[colPhase].columnLabel
                  )}
                </th>
              ))}
              <th className="px-6 py-3 text-left">Comments</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {section.questions.map((q) => (
              <tr key={q.id}>
                <td className="px-6 py-4 align-top">
                  <p className="font-medium text-slate-700">{q.text}</p>
                  {q.description ? <p className="mt-0.5 text-xs text-slate-400">{q.description}</p> : null}
                </td>
                {appraisalPhases.map((colPhase) => (
                  <ScoreCell
                    key={colPhase}
                    colPhase={colPhase}
                    editPhase={phase}
                    q={q}
                    value={scores[q.id] ?? ""}
                    onChange={(v) => onScore(q.id, v)}
                  />
                ))}
                <td className="px-6 py-4 align-top">
                  <CommentCell colEditPhase={phase} q={q} value={comments[q.id] ?? ""} onChange={(v) => onComment(q.id, v)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 p-4 md:hidden">
        {section.questions.map((q) => (
          <div key={q.id} className="mobile-q-card">
            <div className="mobile-q-card-header">
              {q.text}
              {q.description ? <p className="mt-0.5 text-xs font-normal text-slate-400">{q.description}</p> : null}
            </div>
            <div className="mobile-q-scores">
              {appraisalPhases.map((colPhase) => (
                <MobileScoreCell
                  key={colPhase}
                  colPhase={colPhase}
                  editPhase={phase}
                  q={q}
                  value={scores[q.id] ?? ""}
                  onChange={(v) => onScore(q.id, v)}
                />
              ))}
            </div>
            <div className="mobile-q-comment">
              <CommentCell colEditPhase={phase} q={q} value={comments[q.id] ?? ""} onChange={(v) => onComment(q.id, v)} mobile />
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** state of a score column relative to the editable phase */
function colState(colPhase: AppraisalPhase, editPhase: AppraisalPhase): "edit" | "prior" | "later" {
  const c = PHASE_INDEX[colPhase]
  const e = PHASE_INDEX[editPhase]
  if (c === e) return "edit"
  return c < e ? "prior" : "later"
}

function ScoreCell({
  colPhase,
  editPhase,
  q,
  value,
  onChange,
}: {
  colPhase: AppraisalPhase
  editPhase: AppraisalPhase
  q: AppraisalQuestionView
  value: string
  onChange: (v: string) => void
}) {
  const state = colState(colPhase, editPhase)
  const accent = PHASE_ACCENT[editPhase]
  if (state === "edit") {
    const invalid = value.trim() !== "" && !v_ok(Number(value))
    return (
      <td className={cn("px-4 py-4 text-center align-top", accent.cellBg)}>
        <input
          type="number"
          min={1}
          max={5}
          step={0.01}
          placeholder="1–5"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn("rating-input", accent.inputBorder)}
        />
        {invalid ? <p className="mt-1 text-xs text-red-500">Only 1–5 is accepted</p> : null}
      </td>
    )
  }
  if (state === "prior") {
    const s = phaseScore(q, colPhase)
    return (
      <td className="px-4 py-4 text-center align-top">
        <div className={cn("rating-readonly font-bold", colPhase === "reviewer" ? "text-emerald-700" : "text-slate-600")}>
          {s == null ? "—" : s}
        </div>
      </td>
    )
  }
  return (
    <td className="col-locked px-4 py-4 text-center align-top">
      <div className="rating-readonly text-xs italic text-slate-400">
        {colPhase === "partner" ? "Awaiting Reviewer 2" : "Pending"}
      </div>
    </td>
  )
}

function MobileScoreCell({
  colPhase,
  editPhase,
  q,
  value,
  onChange,
}: {
  colPhase: AppraisalPhase
  editPhase: AppraisalPhase
  q: AppraisalQuestionView
  value: string
  onChange: (v: string) => void
}) {
  const state = colState(colPhase, editPhase)
  const label = PHASE_ACCENT[colPhase].columnLabel
  if (state === "edit") {
    return (
      <div className="mobile-q-score-cell">
        <span className="mobile-q-score-label">✏ {label}</span>
        <input
          type="number"
          min={1}
          max={5}
          step={0.01}
          placeholder="—"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="rating-input-mobile"
        />
      </div>
    )
  }
  if (state === "prior") {
    const s = phaseScore(q, colPhase)
    return (
      <div className="mobile-q-score-cell">
        <span className="mobile-q-score-label">{label}</span>
        <span className="rating-badge">{s == null ? "—" : s}</span>
      </div>
    )
  }
  return (
    <div className="mobile-q-score-cell col-locked">
      <span className="mobile-q-score-label">{label}</span>
      <span className="rating-badge rating-badge-pending">{colPhase === "partner" ? "Awaiting" : "Pending"}</span>
    </div>
  )
}

function CommentCell({
  colEditPhase,
  q,
  value,
  onChange,
  mobile,
}: {
  colEditPhase: AppraisalPhase
  q: AppraisalQuestionView
  value: string
  onChange: (v: string) => void
  mobile?: boolean
}) {
  // Show read-only prior-phase comments for reference, then the editable textarea.
  const priors = appraisalPhases.filter((p) => PHASE_INDEX[p] < PHASE_INDEX[colEditPhase])
  return (
    <div className="space-y-2">
      {priors.map((p) => {
        const c = phaseComment(q, p)
        return (
          <div key={p}>
            <p className={cn("mb-1 text-xs font-semibold", mobile ? "mobile-q-comment-label" : "text-slate-400")}>
              {p === "reviewee" ? "Employee's" : "Reviewer 1's"} comment:
            </p>
            <div className="comment-readonly" style={mobile ? { height: "auto", minHeight: "3rem" } : undefined}>
              {c || <span className="italic text-slate-400">No comment</span>}
            </div>
          </div>
        )
      })}
      <textarea
        rows={3}
        placeholder={
          colEditPhase === "reviewee"
            ? "Add your comments or supporting evidence…"
            : colEditPhase === "reviewer"
              ? "Add your Reviewer 1 comments…"
              : "Add your Reviewer 2 comments…"
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn("comment-input", PHASE_ACCENT[colEditPhase].inputBorder)}
      />
    </div>
  )
}

function SummaryCard({
  phase,
  record,
  value,
  onChange,
}: {
  phase: AppraisalPhase
  record: AppraisalRecord
  value: { goals: string; remarks: string; development: string }
  onChange: (v: { goals: string; remarks: string; development: string }) => void
}) {
  const accent = PHASE_ACCENT[phase]
  const fields: Array<{ key: keyof typeof value; label: string; icon: string; placeholder: string }> = [
    { key: "goals", label: "Goals Review", icon: "flag", placeholder: "Review progress against goals for this cycle…" },
    { key: "remarks", label: "Overall Remarks", icon: "rate_review", placeholder: "Summarise overall performance…" },
    { key: "development", label: "Development Plans", icon: "trending_up", placeholder: "Outline development areas and next steps…" },
  ]
  // reviewee's summary shown for reference to reviewer/partner
  const reference = phase === "reviewee" ? null : record.revieweeSection
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border/60 bg-surface-low/50 px-6 py-4">
        <h3 className="font-bold text-foreground">Summary</h3>
      </div>
      <div className="space-y-5 p-6">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-foreground/90">
              <Icon name={f.icon} className="text-base text-muted-foreground" />
              {f.label}
            </label>
            {reference && reference[f.key] ? (
              <div className="mb-2">
                <p className="mb-1 text-xs font-semibold text-muted-foreground">Employee&apos;s notes:</p>
                <div className="comment-readonly" style={{ height: "auto", minHeight: "3rem" }}>
                  {reference[f.key]}
                </div>
              </div>
            ) : null}
            <textarea
              rows={3}
              placeholder={f.placeholder}
              value={value[f.key]}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
              className={cn("comment-input", accent.inputBorder)}
            />
          </div>
        ))}
      </div>
    </Card>
  )
}
