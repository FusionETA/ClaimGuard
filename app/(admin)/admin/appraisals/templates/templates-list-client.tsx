"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-primary"
            >
              <Icon name="arrow_back" className="text-base" />
              Appraisals
            </Link>
          </div>
          <h1 className="mt-1 text-2xl font-extrabold text-foreground">Question Sets</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Reusable question templates applied when starting an appraisal
          </p>
        </div>
        <Button asChild className="self-start">
          <Link href="/admin/appraisals/templates/new">
            <Icon name="add" className="text-lg" />
            New template
          </Link>
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card className="p-10 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-surface-low">
            <Icon name="quiz" className="text-3xl text-muted-foreground" />
          </div>
          <h3 className="text-lg font-bold text-foreground">No question sets yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Create a template to define the questions employees are scored on. New
            appraisals with no template fall back to the built-in default set.
          </p>
          <Button asChild className="mt-5">
            <Link href="/admin/appraisals/templates/new">
              <Icon name="add" className="text-lg" />
              New template
            </Link>
          </Button>
        </Card>
      ) : (
        <Card className="divide-y divide-border/60 overflow-hidden">
          {templates.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="font-bold text-foreground">{t.name}</p>
                <p className="text-xs text-muted-foreground">
                  {t.questionCount} question{t.questionCount === 1 ? "" : "s"} · updated {formatDate(t.updatedAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => archive(t.id)}
                  disabled={busyId === t.id}
                  className="hover:text-destructive"
                >
                  <Icon name="archive" className="text-base" />
                  <span className="hidden sm:inline">Archive</span>
                </Button>
                <Button asChild variant="secondary" size="sm">
                  <Link href={`/admin/appraisals/templates/${t.id}`}>
                    <Icon name="edit" className="text-base" />
                    Edit
                  </Link>
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}
