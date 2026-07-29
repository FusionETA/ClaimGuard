"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { Icon } from "@/app/(employee)/employee/appraisals/_ui"
import {
  appraisalTypeLabel,
  appraisalTypes,
  type AppraisalType,
  type StartAppraisalEmployee,
  type StartAppraisalPageData,
} from "@/modules/appraisify/domain/models"

import { createAppraisalsAction } from "../actions"

type Assignment = { reviewerId: string; partnerId: string }

export function StartAppraisalClient({
  data,
  currentYear,
}: {
  data: StartAppraisalPageData
  currentYear: number
}) {
  const router = useRouter()

  const [employees, setEmployees] = useState<StartAppraisalEmployee[]>(data.employees)
  const [type, setType] = useState<AppraisalType>("ANNUAL")
  const [year, setYear] = useState(currentYear)
  const [templateId, setTemplateId] = useState<string>("")
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({})
  const [showDefaults, setShowDefaults] = useState(false)
  const [defaultReviewerId, setDefaultReviewerId] = useState("")
  const [defaultPartnerId, setDefaultPartnerId] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const yearOptions = useMemo(() => {
    const years: number[] = []
    for (let y = currentYear + 1; y >= currentYear - 5; y -= 1) years.push(y)
    return years
  }, [currentYear])

  const selectedTemplate = data.templates.find((t) => t.id === templateId) ?? null

  function setAssignment(employeeId: string, field: keyof Assignment, value: string) {
    setAssignments((prev) => {
      const current: Assignment = prev[employeeId] ?? { reviewerId: "", partnerId: "" }
      return { ...prev, [employeeId]: { ...current, [field]: value } }
    })
  }

  function removeEmployee(id: string) {
    setEmployees((prev) => prev.filter((e) => e.id !== id))
    setAssignments((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  function applyDefaultsToAll() {
    if (!defaultReviewerId && !defaultPartnerId) return
    setAssignments((prev) => {
      const next = { ...prev }
      for (const emp of employees) {
        next[emp.id] = {
          reviewerId: defaultReviewerId || next[emp.id]?.reviewerId || "",
          partnerId: defaultPartnerId || next[emp.id]?.partnerId || "",
        }
      }
      return next
    })
  }

  const invalidEmployeeIds = useMemo(() => {
    const invalid = new Set<string>()
    for (const emp of employees) {
      const a = assignments[emp.id]
      if (!a?.reviewerId || !a?.partnerId) {
        invalid.add(emp.id)
        continue
      }
      if (a.reviewerId === a.partnerId) invalid.add(emp.id)
      if (a.reviewerId === emp.id || a.partnerId === emp.id) invalid.add(emp.id)
    }
    return invalid
  }, [employees, assignments])

  const canLaunch = employees.length > 0 && invalidEmployeeIds.size === 0

  async function launch() {
    if (!canLaunch) return
    setSubmitting(true)
    setError(null)
    const res = await createAppraisalsAction({
      assignments: employees.map((e) => ({
        employeeId: e.id,
        reviewerId: assignments[e.id]!.reviewerId,
        partnerId: assignments[e.id]!.partnerId,
      })),
      year,
      type,
      templateId: templateId || null,
    })
    if (res.ok) {
      router.push("/admin/appraisals")
      router.refresh()
    } else {
      setError(res.message)
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-28">
      {/* Sub-header */}
      <div>
        <Link
          href="/admin/appraisals"
          className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-primary"
        >
          <Icon name="arrow_back" className="text-lg" />
          Dashboard
        </Link>
        <h1 className="mt-3 text-2xl font-extrabold text-foreground">Configure Appraisal Cycle</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Assign Reviewer 1 and Reviewer 2 for each employee, then launch the cycle.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left: cycle settings */}
        <div className="space-y-5 lg:col-span-1">
          <Card>
            <CardHeader className="border-b border-border/60 pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon name="settings" className="text-lg text-primary" />
                Cycle Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5 pt-6">
              <div>
                <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Appraisal Type
                </Label>
                <Select value={type} onValueChange={(v) => setType(v as AppraisalType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {appraisalTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {appraisalTypeLabel(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Year
                </Label>
                <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {yearOptions.map((y) => (
                      <SelectItem key={y} value={String(y)}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Question Set
                </Label>
                <Select value={templateId} onValueChange={setTemplateId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Default question set" />
                  </SelectTrigger>
                  <SelectContent>
                    {data.templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} ({t.questionCount})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {selectedTemplate
                    ? `${selectedTemplate.questionCount} questions`
                    : "Uses the built-in default question set."}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: employees + assignments */}
        <div className="space-y-5 lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border/60 pb-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon name="group" className="text-lg text-primary" />
                Selected Employees
                <Badge variant="outline" className="ml-1 px-2 py-0.5 text-[10px] normal-case tracking-normal">
                  {employees.length}
                </Badge>
              </CardTitle>
              <button
                type="button"
                onClick={() => setShowDefaults((v) => !v)}
                className="text-xs font-semibold text-primary hover:underline"
              >
                Default assignments
              </button>
            </CardHeader>

            {showDefaults ? (
              <div className="border-b border-border/60 bg-surface-low/60 px-6 py-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <div>
                    <Label className="mb-1 block text-xs text-muted-foreground">Default Reviewer 1</Label>
                    <PersonSelect
                      value={defaultReviewerId}
                      onChange={setDefaultReviewerId}
                      people={data.people}
                      placeholder="Select…"
                    />
                  </div>
                  <div>
                    <Label className="mb-1 block text-xs text-muted-foreground">Default Reviewer 2</Label>
                    <PersonSelect
                      value={defaultPartnerId}
                      onChange={setDefaultPartnerId}
                      people={data.people}
                      placeholder="Select…"
                    />
                  </div>
                  <Button type="button" variant="secondary" size="sm" onClick={applyDefaultsToAll}>
                    Apply to all
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="divide-y divide-border/60">
              {employees.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                  <Icon name="person_off" className="mb-2 block text-3xl text-muted-foreground/60" />
                  No employees selected. Go back to the dashboard to select employees.
                </div>
              ) : (
                employees.map((emp) => {
                  const a = assignments[emp.id]
                  const invalid = invalidEmployeeIds.has(emp.id)
                  const otherPeople = data.people.filter((p) => p.id !== emp.id)
                  return (
                    <div key={emp.id} className="px-6 py-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                            {emp.initials}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-foreground">{emp.name}</p>
                            <p className="text-xs text-muted-foreground">{emp.position || "Employee"}</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeEmployee(emp.id)}
                          title="Remove"
                          className="shrink-0 text-muted-foreground/60 transition-colors hover:text-destructive"
                        >
                          <Icon name="close" className="text-lg" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label className="mb-1 block text-xs text-muted-foreground">Reviewer 1</Label>
                          <PersonSelect
                            value={a?.reviewerId ?? ""}
                            onChange={(v) => setAssignment(emp.id, "reviewerId", v)}
                            people={otherPeople}
                            placeholder="Assign…"
                          />
                        </div>
                        <div>
                          <Label className="mb-1 block text-xs text-muted-foreground">Reviewer 2</Label>
                          <PersonSelect
                            value={a?.partnerId ?? ""}
                            onChange={(v) => setAssignment(emp.id, "partnerId", v)}
                            people={otherPeople}
                            placeholder="Assign…"
                          />
                        </div>
                      </div>
                      {invalid && (a?.reviewerId || a?.partnerId) ? (
                        <p className="mt-1.5 text-xs text-destructive">
                          Reviewer 1 and Reviewer 2 must both be set and be different people.
                        </p>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
          </Card>

          {/* Launch summary */}
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-5">
              <h3 className="mb-3 flex items-center gap-2 font-bold text-foreground">
                <Icon name="summarize" className="text-lg text-primary" />
                Launch Summary
              </h3>
              <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-3">
                <SummaryTile value={employees.length} label="Employees" />
                <SummaryTile value={appraisalTypeLabel(type)} label="Type" />
                <SummaryTile value={String(year)} label="Year" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Action bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border/60 bg-card/95 px-4 py-4 backdrop-blur-sm lg:pl-[280px]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <Button variant="outline" asChild>
            <Link href="/admin/appraisals">
              <Icon name="arrow_back" className="text-lg" />
              Cancel
            </Link>
          </Button>
          <div className="flex items-center gap-3">
            {!canLaunch && employees.length > 0 ? (
              <span className="hidden items-center gap-1 text-xs font-medium text-amber-600 sm:flex">
                <Icon name="warning" className="text-sm" />
                Assign Reviewer 1 and Reviewer 2 to every employee
              </span>
            ) : null}
            {error ? <span className="text-xs font-medium text-destructive">{error}</span> : null}
            <Button onClick={launch} disabled={!canLaunch || submitting}>
              <Icon name={submitting ? "sync" : "rocket_launch"} className={cn("text-lg", submitting && "animate-spin")} />
              {submitting ? "Launching…" : "Launch Appraisal"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SummaryTile({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="text-lg font-black text-primary">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function PersonSelect({
  value,
  onChange,
  people,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  people: { id: string; name: string }[]
  placeholder: string
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="h-10 text-sm sm:h-10">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {people.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
