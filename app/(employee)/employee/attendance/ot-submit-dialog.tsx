"use client"

import { useState, useTransition } from "react"
import { Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
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
import { Textarea } from "@/components/ui/textarea"
import type { AttendanceProjectView } from "@/modules/attendance/domain/models"

import { submitOtAction } from "./actions"

type Props = {
  projects: AttendanceProjectView[]
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function computeDuration(startTime: string, endTime: string): string | null {
  if (!startTime || !endTime) return null
  const [sh, sm] = startTime.split(":").map(Number)
  const [eh, em] = endTime.split(":").map(Number)
  if (sh === undefined || sm === undefined || eh === undefined || em === undefined) return null
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  const diff = endMin - startMin
  if (diff <= 0 || diff > 24 * 60) return null
  const h = Math.floor(diff / 60)
  const m = diff % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function OtSubmitButton({ projects }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label="Submit overtime"
        onClick={() => setOpen(true)}
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-panel transition-transform hover:scale-105 active:scale-95 lg:bottom-8 lg:right-8"
      >
        <Plus className="h-6 w-6" />
      </button>
      <OtSubmitDialog open={open} onOpenChange={setOpen} projects={projects} />
    </>
  )
}

function OtSubmitDialog({
  open,
  onOpenChange,
  projects,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projects: AttendanceProjectView[]
}) {
  const [date, setDate] = useState(todayIso)
  const [startTime, setStartTime] = useState("")
  const [endTime, setEndTime] = useState("")
  const [projectId, setProjectId] = useState("")
  const [notes, setNotes] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const duration = computeDuration(startTime, endTime)

  function reset() {
    setDate(todayIso())
    setStartTime("")
    setEndTime("")
    setProjectId("")
    setNotes("")
    setMessage(null)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)
    const fd = new FormData()
    fd.set("date", date)
    fd.set("otStartTime", startTime)
    fd.set("otEndTime", endTime)
    if (projectId) fd.set("otProjectId", projectId)
    if (notes.trim()) fd.set("notes", notes.trim())
    startTransition(async () => {
      const res = await submitOtAction(fd)
      if (!res.ok) {
        setMessage(res.error ?? "Could not submit OT.")
        return
      }
      reset()
      onOpenChange(false)
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset()
        onOpenChange(v)
      }}
    >
      <DialogContent className="flex max-h-[90vh] w-[min(92vw,480px)] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>Submit overtime</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 overflow-y-auto px-6 py-4">
          <div className="space-y-1.5">
            <Label htmlFor="ot-date">Date</Label>
            <Input
              id="ot-date"
              type="date"
              max={todayIso()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ot-start">OT start</Label>
              <Input
                id="ot-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ot-end">OT end</Label>
              <Input
                id="ot-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                required
              />
            </div>
          </div>

          {duration ? (
            <p className="text-sm font-medium text-muted-foreground">
              Duration: <span className="text-foreground">{duration}</span>
            </p>
          ) : endTime && startTime ? (
            <p className="text-sm text-destructive">End time must be after start time.</p>
          ) : null}

          {projects.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor="ot-project">Project (optional)</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="ot-project">
                  <SelectValue placeholder="Select project…" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="ot-notes">Reason (optional)</Label>
            <Textarea
              id="ot-notes"
              placeholder="Briefly describe the OT work done…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>

          {message ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {message}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset()
                onOpenChange(false)
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !duration}>
              {isPending ? "Submitting…" : "Submit OT"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
