"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { Icon, StatusBadge, fmtScore } from "@/app/(employee)/employee/appraisals/_ui"
import {
  buildCycleLabel,
  groupQuestionsBySection,
  phaseLabel,
  scoreSummary,
  type AppraisalRecord,
  type AppraisalSectionText,
} from "@/modules/appraisify/domain/models"

export function AdminAppraisalDetailClient({ record }: { record: AppraisalRecord }) {
  const cycleLabel = buildCycleLabel(record.type, record.year)
  const scores = scoreSummary(record.questions)
  const sections = groupQuestionsBySection(record.questions)
  const complete = record.stage === "SUBMITTED"

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-10">
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/admin/appraisals"
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
        >
          <Icon name="arrow_back" className="text-lg" />
          Dashboard
        </Link>
        {complete ? (
          <Button asChild variant="outline" size="sm">
            <a href={`/admin/appraisals/${record.id}/report`}>
              <Icon name="download" className="text-lg" />
              Download PDF
            </a>
          </Button>
        ) : null}
      </div>

      <Card className="flex flex-col justify-between gap-4 p-6 md:flex-row md:items-center">
        <div>
          <h1 className="text-xl font-bold text-foreground">{record.reviewee.name}</h1>
          <p className="text-sm text-muted-foreground">
            {[record.role, record.team].filter(Boolean).join(" · ") || "—"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-bold text-primary">
              {cycleLabel}
            </span>
            <StatusBadge stage={record.stage} />
            <span className="font-mono text-xs text-muted-foreground">{record.referenceNumber}</span>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <ScoreTile label="Self" score={scores.self} accent="text-primary bg-primary/10" />
        <ScoreTile label={phaseLabel("reviewer")} score={scores.reviewer} accent="text-indigo-500 bg-indigo-500/10" />
        <ScoreTile label={phaseLabel("partner")} score={scores.partner} accent="text-emerald-500 bg-emerald-500/10" />
      </div>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-muted-foreground">Participants</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <ParticipantField label="Reviewee" name={record.reviewee.name} />
          <ParticipantField label={phaseLabel("reviewer")} name={record.reviewer.name} />
          <ParticipantField label={phaseLabel("partner")} name={record.partner.name} />
        </div>
      </Card>

      {sections.map(({ section, questions }) => (
        <Card key={section} className="overflow-hidden">
          <div className="border-b border-border/60 px-6 py-4">
            <h2 className="font-bold text-foreground">{section}</h2>
          </div>
          <div className="divide-y divide-border/60">
            {questions.map((q) => (
              <div key={q.id} className="px-6 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{q.text}</p>
                    {q.description ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{q.description}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-4 text-center">
                    <ScoreCell label="Self" score={q.revieweeScore} />
                    <ScoreCell label={phaseLabel("reviewer")} score={q.reviewerScore} />
                    <ScoreCell label={phaseLabel("partner")} score={q.partnerScore} />
                  </div>
                </div>
                <QuestionComments question={q} />
              </div>
            ))}
          </div>
        </Card>
      ))}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <PhaseTextCard title="Self-Assessment" section={record.revieweeSection} />
        <PhaseTextCard title={phaseLabel("reviewer")} section={record.reviewerSection} />
        <PhaseTextCard title={phaseLabel("partner")} section={record.partnerSection} />
      </div>
    </div>
  )
}

function ScoreTile({
  label,
  score,
  accent,
}: {
  label: string
  score: number | null
  accent: string
}) {
  const pct = score == null ? 0 : (score / 5) * 100
  return (
    <Card className="bg-surface-low p-5 shadow-none">
      <div className="mb-3 flex items-start justify-between">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
        <Icon name="star" className={cn("rounded-lg p-1.5 text-lg", accent)} />
      </div>
      <div className="mb-3 text-3xl font-black text-foreground">{fmtScore(score)}</div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </Card>
  )
}

function ParticipantField({ label, name }: { label: string; name: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-semibold text-foreground">{name}</p>
    </div>
  )
}

function ScoreCell({ label, score }: { label: string; score: number | null }) {
  return (
    <div className="w-16">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-bold text-foreground">{fmtScore(score)}</p>
    </div>
  )
}

function QuestionComments({
  question,
}: {
  question: {
    revieweeComment: string | null
    reviewerComment: string | null
    partnerComment: string | null
  }
}) {
  const comments: Array<{ label: string; value: string | null }> = [
    { label: "Self", value: question.revieweeComment },
    { label: phaseLabel("reviewer"), value: question.reviewerComment },
    { label: phaseLabel("partner"), value: question.partnerComment },
  ].filter((c) => c.value)

  if (comments.length === 0) return null

  return (
    <div className="mt-3 space-y-1.5 rounded-lg bg-surface-low p-3">
      {comments.map((c) => (
        <p key={c.label} className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{c.label}:</span> {c.value}
        </p>
      ))}
    </div>
  )
}

function PhaseTextCard({
  title,
  section,
}: {
  title: string
  section: AppraisalSectionText
}) {
  const fields: Array<{ label: string; value: string | null }> = [
    { label: "Goals Review", value: section.goals },
    { label: "Overall Remarks", value: section.remarks },
    { label: "Development Plans", value: section.development },
  ]
  const hasAny = fields.some((f) => f.value)

  return (
    <Card className="bg-surface-low p-5 shadow-none">
      <h3 className="mb-3 text-sm font-bold text-primary">{title}</h3>
      {hasAny ? (
        <div className="space-y-3">
          {fields.map((f) =>
            f.value ? (
              <div key={f.label}>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {f.label}
                </p>
                <p className="mt-0.5 text-sm text-foreground">{f.value}</p>
              </div>
            ) : null,
          )}
        </div>
      ) : (
        <p className="text-sm italic text-muted-foreground">Not submitted.</p>
      )}
    </Card>
  )
}
