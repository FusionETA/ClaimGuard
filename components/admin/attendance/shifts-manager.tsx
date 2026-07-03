"use client"

import { Pencil, Plus, Star, Trash2 } from "lucide-react"
import { useMemo, useState, useTransition } from "react"

import {
  createShiftAction,
  deleteShiftAction,
  setDefaultShiftAction,
  updateShiftAction,
} from "@/app/(admin)/admin/attendance/shifts/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/components/ui/toaster"
import type { ShiftView } from "@/modules/attendance/domain/models"

/**
 * Admin shift-management UI (Phase 4).
 *
 * One big table with a project filter — matches the "big table"
 * pattern used across the admin surfaces. Row actions:
 *   - Edit (opens a dialog with the same field set as Add)
 *   - Set as default (only when the row is not already default)
 *   - Delete (guarded server-side; refused when members are assigned)
 *
 * The Add/Edit dialog is the single form component — driven by
 * `mode: "create" | "edit"` state. Field validation runs on the
 * server (zod schema in actions.ts); we don't duplicate it here.
 */
export function ShiftsManager({
  initialShifts,
  projects,
}: {
  initialShifts: ShiftView[]
  projects: Array<{ id: string; name: string }>
}) {
  const [projectFilter, setProjectFilter] = useState<string>("ALL")
  const [dialogState, setDialogState] = useState<
    | { mode: "closed" }
    | { mode: "create" }
    | { mode: "edit"; shift: ShiftView }
  >({ mode: "closed" })

  const filteredShifts = useMemo(() => {
    if (projectFilter === "ALL") return initialShifts
    return initialShifts.filter((s) => s.projectId === projectFilter)
  }, [initialShifts, projectFilter])

  // Group filtered shifts by project name for the table's project
  // column, so consecutive rows for the same project don't repeat.
  const grouped = useMemo(() => {
    const byProject = new Map<string, ShiftView[]>()
    for (const s of filteredShifts) {
      const list = byProject.get(s.projectName) ?? []
      list.push(s)
      byProject.set(s.projectName, list)
    }
    return Array.from(byProject.entries()).map(([projectName, shifts]) => ({
      projectName,
      shifts,
    }))
  }, [filteredShifts])

  return (
    <div className="space-y-4">
      {/* Toolbar — project filter + Add button */}
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-border/60 bg-card/94 p-4">
        <div className="min-w-[220px] flex-1">
          <Label
            htmlFor="shifts-project-filter"
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            Project
          </Label>
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger id="shifts-project-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          onClick={() => setDialogState({ mode: "create" })}
          disabled={projects.length === 0}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          Add shift
        </Button>
      </div>

      {/* The big flat table */}
      <div className="rounded-2xl border border-border/60 bg-card/94">
        {grouped.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {projects.length === 0
              ? "No projects yet — add a project first, then come back to define its shifts."
              : "No shifts match this filter."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-border/60 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-semibold">Project</th>
                  <th className="px-4 py-2 font-semibold">Shift</th>
                  <th className="px-4 py-2 font-semibold">Time</th>
                  <th className="px-4 py-2 font-semibold">Working days</th>
                  <th className="px-4 py-2 font-semibold text-right">Lunch</th>
                  <th className="px-4 py-2 font-semibold text-right">Members</th>
                  <th className="px-4 py-2 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {grouped.flatMap((group) =>
                  group.shifts.map((s, i) => (
                    <ShiftRow
                      key={s.id}
                      shift={s}
                      showProject={i === 0}
                      onEdit={() =>
                        setDialogState({ mode: "edit", shift: s })
                      }
                    />
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Dialog: Add or Edit */}
      {dialogState.mode !== "closed" ? (
        <ShiftDialog
          mode={dialogState.mode}
          shift={dialogState.mode === "edit" ? dialogState.shift : null}
          projects={projects}
          projectFilter={projectFilter}
          onClose={() => setDialogState({ mode: "closed" })}
        />
      ) : null}
    </div>
  )
}

// ─── Row ─────────────────────────────────────────────────────────

function ShiftRow({
  shift,
  showProject,
  onEdit,
}: {
  shift: ShiftView
  showProject: boolean
  onEdit: () => void
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()

  function handleSetDefault() {
    if (shift.isDefault) return
    startTransition(async () => {
      const result = await setDefaultShiftAction(shift.id)
      if (!result.ok) {
        toast({ title: result.error, variant: "error" })
      } else {
        toast({ title: `"${shift.name}" is now the default.` })
      }
    })
  }

  function handleDelete() {
    if (
      !window.confirm(
        `Delete shift "${shift.name}"? This can't be undone.`,
      )
    ) {
      return
    }
    startTransition(async () => {
      const result = await deleteShiftAction(shift.id)
      if (!result.ok) {
        toast({ title: result.error, variant: "error" })
      } else {
        toast({ title: `Deleted "${shift.name}".` })
      }
    })
  }

  return (
    <tr className="border-b border-border/40 last:border-b-0 hover:bg-muted/30">
      <td className="px-4 py-3">
        {showProject ? (
          <span className="font-medium text-foreground">{shift.projectName}</span>
        ) : (
          <span className="text-muted-foreground">·</span>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{shift.name}</span>
          {shift.isDefault ? (
            <Badge variant="approved" className="gap-1 text-[10px]">
              <Star className="h-3 w-3" />
              Default
            </Badge>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-3 tabular-nums">
        {shift.startTime} – {shift.endTime}
      </td>
      <td className="px-4 py-3">
        <span className="text-xs text-muted-foreground">
          {formatWorkingDays(shift.workingDays)}
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {shift.lunchBreakMin}m
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {shift.assignedMemberCount}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-1">
          {!shift.isDefault ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleSetDefault}
              disabled={pending}
              title="Set as default for this project"
              className="h-8 w-8 p-0"
            >
              <Star className="h-4 w-4" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onEdit}
            disabled={pending}
            title="Edit"
            className="h-8 w-8 p-0"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            disabled={pending}
            title="Delete"
            className="h-8 w-8 p-0 text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </td>
    </tr>
  )
}

// ─── Dialog ───────────────────────────────────────────────────────

function ShiftDialog({
  mode,
  shift,
  projects,
  projectFilter,
  onClose,
}: {
  mode: "create" | "edit"
  shift: ShiftView | null
  projects: Array<{ id: string; name: string }>
  projectFilter: string
  onClose: () => void
}) {
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  // Pre-fill from the target shift on edit, or from the current
  // project filter on create (so admin picks a project once).
  const [projectId, setProjectId] = useState<string>(
    shift?.projectId ??
      (projectFilter !== "ALL" ? projectFilter : projects[0]?.id ?? ""),
  )
  const [name, setName] = useState(shift?.name ?? "")
  const [startTime, setStartTime] = useState(shift?.startTime ?? "09:00")
  const [endTime, setEndTime] = useState(shift?.endTime ?? "18:00")
  const [workingDays, setWorkingDays] = useState(
    shift?.workingDays ?? "1,2,3,4,5",
  )
  const [lunchBreakMin, setLunchBreakMin] = useState(
    String(shift?.lunchBreakMin ?? 60),
  )
  const [isDefault, setIsDefault] = useState(shift?.isDefault ?? false)

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFieldErrors({})
    setFormError(null)
    const fd = new FormData(e.currentTarget)

    startTransition(async () => {
      const result =
        mode === "create"
          ? await createShiftAction(fd)
          : await updateShiftAction(shift!.id, fd)
      if (!result.ok) {
        setFormError(result.error)
        if (result.fieldErrors) setFieldErrors(result.fieldErrors)
        return
      }
      toast({
        title:
          mode === "create"
            ? `Added shift "${name}".`
            : `Updated shift "${name}".`,
      })
      onClose()
    })
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Add shift" : `Edit shift "${shift?.name}"`}
          </DialogTitle>
          <DialogDescription>
            Times are HH:MM (24-hour). Working days are ISO weekdays —
            1 = Monday, 7 = Sunday.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="shift-project">Project</Label>
            <Select
              value={projectId}
              onValueChange={setProjectId}
              disabled={mode === "edit"}
              name="projectId"
            >
              <SelectTrigger id="shift-project">
                <SelectValue placeholder="Pick a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Radix Select doesn't render a native input; sync value into
                a hidden input for FormData. */}
            <input type="hidden" name="projectId" value={projectId} />
            {mode === "edit" ? (
              <p className="text-[11px] text-muted-foreground">
                Project can&apos;t be moved once a shift exists. Delete and
                re-create if it needs to belong to a different project.
              </p>
            ) : null}
            {fieldErrors.projectId ? (
              <p className="text-xs text-destructive">
                {fieldErrors.projectId}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="shift-name">Name</Label>
            <Input
              id="shift-name"
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Day 8am-5pm"
              aria-invalid={Boolean(fieldErrors.name)}
              required
              maxLength={80}
            />
            {fieldErrors.name ? (
              <p className="text-xs text-destructive">{fieldErrors.name}</p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="shift-start">Start time</Label>
              <Input
                id="shift-start"
                name="startTime"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                aria-invalid={Boolean(fieldErrors.startTime)}
                required
              />
              {fieldErrors.startTime ? (
                <p className="text-xs text-destructive">
                  {fieldErrors.startTime}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="shift-end">End time</Label>
              <Input
                id="shift-end"
                name="endTime"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                aria-invalid={Boolean(fieldErrors.endTime)}
                required
              />
              {fieldErrors.endTime ? (
                <p className="text-xs text-destructive">
                  {fieldErrors.endTime}
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="shift-days">Working days</Label>
            <Input
              id="shift-days"
              name="workingDays"
              value={workingDays}
              onChange={(e) => setWorkingDays(e.target.value)}
              placeholder="1,2,3,4,5"
              aria-invalid={Boolean(fieldErrors.workingDays)}
            />
            <p className="text-[11px] text-muted-foreground">
              Comma-separated. Leave blank to inherit the project default.
            </p>
            {fieldErrors.workingDays ? (
              <p className="text-xs text-destructive">
                {fieldErrors.workingDays}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="shift-lunch">Lunch break (minutes)</Label>
            <Input
              id="shift-lunch"
              name="lunchBreakMin"
              type="number"
              min={0}
              max={240}
              value={lunchBreakMin}
              onChange={(e) => setLunchBreakMin(e.target.value)}
              aria-invalid={Boolean(fieldErrors.lunchBreakMin)}
              required
            />
            {fieldErrors.lunchBreakMin ? (
              <p className="text-xs text-destructive">
                {fieldErrors.lunchBreakMin}
              </p>
            ) : null}
          </div>

          <label className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
            <input
              type="checkbox"
              name="isDefault"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Set as default</span> for this
              project. Any existing default is unset atomically.
            </span>
          </label>

          {formError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {formError}
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending
                ? "Saving…"
                : mode === "create"
                  ? "Add shift"
                  : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

function formatWorkingDays(csv: string | null): string {
  if (!csv) return "Project default"
  const nums = csv
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => n >= 1 && n <= 7)
  if (nums.length === 0) return "Project default"
  if (nums.length === 7) return "Everyday"
  // Common pattern: Mon-Fri
  if (
    nums.length === 5 &&
    [1, 2, 3, 4, 5].every((n) => nums.includes(n))
  ) {
    return "Mon-Fri"
  }
  return nums.map((n) => DAY_LABELS[n - 1]).join(", ")
}
