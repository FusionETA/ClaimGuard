"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"

import { cn } from "@/lib/utils"
import { Icon, formatDate } from "@/app/(employee)/employee/appraisals/_ui"
import type { AppraisalTemplateSummary } from "@/modules/appraisify/domain/models"

import { archiveTemplateAction } from "./actions"

export function TemplatesListClient({
  templates,
}: {
  templates: AppraisalTemplateSummary[]
}) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function archive(id: string) {
    if (!confirm("Archive this template? It will no longer be selectable for new appraisals.")) return
    setBusyId(id)
    const res = await archiveTemplateAction(id)
    setBusyId(null)
    if (res.ok) router.refresh()
    else alert(res.message ?? "Could not archive template.")
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/admin/appraisals"
              className="flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-primary"
            >
              <Icon name="arrow_back" className="text-base" />
              Appraisals
            </Link>
          </div>
          <h1 className="mt-1 text-2xl font-extrabold text-slate-900">Question Sets</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Reusable question templates applied when starting an appraisal
          </p>
        </div>
        <Link
          href="/admin/appraisals/templates/new"
          className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-primary/30 transition-colors hover:bg-primary/90"
        >
          <Icon name="add" className="text-lg" />
          New template
        </Link>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-100">
            <Icon name="quiz" className="text-3xl text-slate-400" />
          </div>
          <h3 className="text-lg font-bold text-slate-900">No question sets yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            Create a template to define the questions employees are scored on. New
            appraisals with no template fall back to the built-in default set.
          </p>
          <Link
            href="/admin/appraisals/templates/new"
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-white hover:bg-primary/90"
          >
            <Icon name="add" className="text-lg" />
            New template
          </Link>
        </div>
      ) : (
        <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {templates.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="font-bold text-slate-800">{t.name}</p>
                <p className="text-xs text-slate-500">
                  {t.questionCount} question{t.questionCount === 1 ? "" : "s"} · updated {formatDate(t.updatedAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => archive(t.id)}
                  disabled={busyId === t.id}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-500 transition-colors hover:bg-slate-50 hover:text-red-600 disabled:opacity-50"
                >
                  <Icon name="archive" className="text-base" />
                  <span className="hidden sm:inline">Archive</span>
                </button>
                <Link
                  href={`/admin/appraisals/templates/${t.id}`}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-lg bg-primary/10 px-3 py-2 text-sm font-bold text-primary transition-colors hover:bg-primary/20",
                  )}
                >
                  <Icon name="edit" className="text-base" />
                  Edit
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
