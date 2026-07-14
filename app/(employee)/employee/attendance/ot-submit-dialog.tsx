"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { Camera, Clock, FileUp, Paperclip, Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
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

import { CameraCaptureModal } from "@/components/attendance/camera-capture-modal"
import { submitOtAction } from "./actions"

// ─── helpers ───────────────────────────────────────────────────────────────

type Props = { projects: AttendanceProjectView[] }

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function fmt12h(time24: string): string {
  if (!time24) return ""
  const [hStr, mStr] = time24.split(":")
  const h24 = parseInt(hStr ?? "")
  const m = parseInt(mStr ?? "")
  if (isNaN(h24) || isNaN(m)) return ""
  const period = h24 >= 12 ? "PM" : "AM"
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24
  return `${h12}:${String(m).padStart(2, "0")} ${period}`
}

function parseTimeText(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, "")
  if (!t) return null
  const periodMatch = t.match(/(am|pm)$/)
  const period = periodMatch ? (periodMatch[1] as "am" | "pm") : undefined
  const digits = t.replace(/(am|pm)$/, "")
  let h: number, m: number
  const colonMatch = digits.match(/^(\d{1,2}):(\d{2})$/)
  if (colonMatch) {
    h = parseInt(colonMatch[1])
    m = parseInt(colonMatch[2])
  } else if (/^\d{3,4}$/.test(digits)) {
    h = digits.length === 3 ? parseInt(digits[0]) : parseInt(digits.slice(0, 2))
    m = digits.length === 3 ? parseInt(digits.slice(1)) : parseInt(digits.slice(2))
  } else if (/^\d{1,2}$/.test(digits)) {
    h = parseInt(digits)
    m = 0
  } else {
    return null
  }
  if (isNaN(h) || isNaN(m) || m < 0 || m > 59) return null
  if (!period && (h >= 13 || h === 0)) {
    if (h > 23) return null
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
  }
  if (h < 1 || h > 12) return null
  const p = period ?? "am"
  let h24 = h
  if (p === "am" && h === 12) h24 = 0
  else if (p === "pm" && h !== 12) h24 = h + 12
  return `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

function computeDuration(startTime: string, endTime: string): string | null {
  if (!startTime || !endTime) return null
  const [sh, sm] = startTime.split(":").map(Number)
  const [eh, em] = endTime.split(":").map(Number)
  if (sh === undefined || sm === undefined || eh === undefined || em === undefined) return null
  const diff = eh * 60 + em - (sh * 60 + sm)
  if (diff <= 0 || diff > 24 * 60) return null
  const h = Math.floor(diff / 60)
  const mn = diff % 60
  return mn === 0 ? `${h}h` : `${h}h ${mn}m`
}

// ─── Scroll drum column ─────────────────────────────────────────────────────

const ITEM_H = 40   // px per row
const VISIBLE = 5   // rows visible
const PAD = ITEM_H * Math.floor(VISIBLE / 2)  // top/bottom padding so first/last can centre

type DrumItem = { value: string; label: string }

function DrumColumn({
  items,
  selected,
  onSelect,
  width = "w-12",
}: {
  items: DrumItem[]
  selected: string
  onSelect: (v: string) => void
  width?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isUserScrolling = useRef(false)

  // Scroll to the selected item (no animation on initial open)
  const scrollTo = useCallback(
    (value: string, behavior: ScrollBehavior = "smooth") => {
      const idx = items.findIndex((i) => i.value === value)
      if (idx < 0 || !ref.current) return
      ref.current.scrollTo({ top: idx * ITEM_H, behavior })
    },
    [items],
  )

  // On mount / when selected changes from outside, snap without animation
  useEffect(() => {
    if (!isUserScrolling.current) scrollTo(selected, "instant")
  }, [selected, scrollTo])

  function handleScroll() {
    isUserScrolling.current = true
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      if (!ref.current) return
      const idx = Math.round(ref.current.scrollTop / ITEM_H)
      const item = items[Math.max(0, Math.min(idx, items.length - 1))]
      if (item && item.value !== selected) onSelect(item.value)
      // Snap cleanly after debounce
      ref.current.scrollTo({ top: (idx) * ITEM_H, behavior: "smooth" })
      isUserScrolling.current = false
    }, 120)
  }

  return (
    <div
      ref={ref}
      onScroll={handleScroll}
      className={cn(
        "overflow-y-scroll overscroll-contain",
        "[&::-webkit-scrollbar]:hidden",
        width,
      )}
      style={{
        height: ITEM_H * VISIBLE,
        paddingTop: PAD,
        paddingBottom: PAD,
        scrollbarWidth: "none",
        msOverflowStyle: "none",
      }}
    >
      {items.map((item) => (
        <div
          key={item.value}
          onClick={() => {
            onSelect(item.value)
            scrollTo(item.value)
          }}
          className={cn(
            "flex cursor-pointer items-center justify-center text-sm transition-colors select-none",
            item.value === selected
              ? "font-semibold text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          style={{ height: ITEM_H }}
        >
          {item.label}
        </div>
      ))}
    </div>
  )
}

// ─── TimeInput ──────────────────────────────────────────────────────────────

const HOURS: DrumItem[] = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((h) => ({
  value: String(h),
  label: String(h),
}))

const MINUTES: DrumItem[] = Array.from({ length: 12 }, (_, i) => {
  const m = i * 5
  const label = `:${String(m).padStart(2, "0")}`
  return { value: String(m), label }
})

const PERIODS: DrumItem[] = [
  { value: "AM", label: "AM" },
  { value: "PM", label: "PM" },
]

type TimeInputProps = {
  label: string
  id: string
  value: string          // "HH:MM" 24-h or ""
  onChange: (v: string) => void
  defaultPeriod?: "AM" | "PM"
}

function TimeInput({ label, id, value, onChange, defaultPeriod = "AM" }: TimeInputProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [inputText, setInputText] = useState(() => fmt12h(value))
  const containerRef = useRef<HTMLDivElement>(null)

  // Sync display text when value is cleared from outside (reset)
  useEffect(() => {
    if (!value) setInputText("")
    else setInputText(fmt12h(value))
  }, [value])

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return
    function handleDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handleDown)
    return () => document.removeEventListener("mousedown", handleDown)
  }, [isOpen])

  // ── derive picker values from canonical 24-h string
  const h24 = value ? parseInt(value.slice(0, 2)) : NaN
  const minVal = value ? parseInt(value.slice(3, 5)) : NaN

  // Snap minute to nearest 5-min step
  const snappedMin = isNaN(minVal) ? 0 : Math.round(minVal / 5) * 5 % 60

  const selPeriod: "AM" | "PM" = isNaN(h24) ? defaultPeriod : h24 >= 12 ? "PM" : "AM"
  const selH12 = isNaN(h24) ? 12 : h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24

  function build(h12: number, m: number, p: "AM" | "PM"): string {
    let h = h12
    if (p === "AM" && h12 === 12) h = 0
    else if (p === "PM" && h12 !== 12) h = h12 + 12
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
  }

  function handleHourChange(v: string) {
    const h = parseInt(v)
    onChange(build(h, isNaN(minVal) ? 0 : minVal, selPeriod))
  }

  function handleMinChange(v: string) {
    const m = parseInt(v)
    onChange(build(selH12, m, selPeriod))
  }

  function handlePeriodChange(v: string) {
    const p = v as "AM" | "PM"
    onChange(build(selH12, isNaN(minVal) ? 0 : minVal, p))
  }

  function handleBlur() {
    const parsed = parseTimeText(inputText)
    if (parsed) {
      onChange(parsed)
      setInputText(fmt12h(parsed))
    } else if (!inputText.trim()) {
      onChange("")
    }
  }

  return (
    <div ref={containerRef} className="relative space-y-1.5">
      <Label htmlFor={id}>{label}</Label>

      {/* Text input */}
      <div className="flex h-10 items-center gap-2 rounded-md border border-input bg-background px-3 focus-within:outline-none focus-within:ring-2 focus-within:ring-ring transition-shadow">
        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          id={id}
          type="text"
          placeholder="e.g. 7:30 PM"
          value={inputText}
          autoComplete="off"
          onFocus={() => setIsOpen(true)}
          onChange={(e) => setInputText(e.target.value)}
          onBlur={handleBlur}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {/* Drum picker dropdown */}
      {isOpen && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-xl border border-border bg-background shadow-lg"
          onMouseDown={(e) => e.preventDefault()} // keep focus on text input
        >
          {/* Highlight band */}
          <div className="pointer-events-none absolute inset-x-0 z-10" style={{
            top: "50%",
            transform: "translateY(-50%)",
            height: ITEM_H,
          }}>
            <div className="h-full border-y border-border bg-muted/50" />
          </div>

          {/* Fade masks */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 bg-gradient-to-b from-background to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-16 bg-gradient-to-t from-background to-transparent" />

          {/* Columns */}
          <div className="relative flex items-start justify-center gap-0 px-4">
            <DrumColumn
              items={HOURS}
              selected={String(selH12)}
              onSelect={handleHourChange}
              width="w-12"
            />
            <div className="flex items-center self-center text-sm font-semibold text-muted-foreground"
              style={{ height: ITEM_H }}>
              :
            </div>
            <DrumColumn
              items={MINUTES}
              selected={String(snappedMin)}
              onSelect={handleMinChange}
              width="w-14"
            />
            <DrumColumn
              items={PERIODS}
              selected={selPeriod}
              onSelect={handlePeriodChange}
              width="w-12"
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── FAB ───────────────────────────────────────────────────────────────────

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

// ─── Dialog ────────────────────────────────────────────────────────────────

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
  const [justificationFiles, setJustificationFiles] = useState<File[]>([])
  const [justificationError, setJustificationError] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const duration = computeDuration(startTime, endTime)
  const timeError = startTime && endTime && !duration

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return
    function handleDown(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener("mousedown", handleDown)
    return () => document.removeEventListener("mousedown", handleDown)
  }, [pickerOpen])

  function addJustificationFiles(files: FileList | File[] | null) {
    if (!files || files.length === 0) return
    setJustificationFiles((prev) => [...prev, ...Array.from(files)])
    setJustificationError(false)
    setPickerOpen(false)
  }

  function removeJustificationFile(idx: number) {
    setJustificationFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  function reset() {
    setDate(todayIso())
    setStartTime("")
    setEndTime("")
    setProjectId("")
    setNotes("")
    setJustificationFiles([])
    setJustificationError(false)
    setPickerOpen(false)
    if (fileInputRef.current) fileInputRef.current.value = ""
    setMessage(null)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!startTime || !endTime) {
      setMessage("Please set a start and end time.")
      return
    }
    if (!duration) {
      setMessage("End time must be after start time.")
      return
    }
    if (justificationFiles.length === 0) {
      setJustificationError(true)
      setMessage("Please attach at least one justification file before submitting.")
      return
    }
    setJustificationError(false)
    setMessage(null)
    const fd = new FormData()
    fd.set("date", date)
    fd.set("otStartAtUtc", new Date(`${date}T${startTime}:00`).toISOString())
    fd.set("otEndAtUtc", new Date(`${date}T${endTime}:00`).toISOString())
    if (projectId) fd.set("otProjectId", projectId)
    if (notes.trim()) fd.set("notes", notes.trim())
    for (const file of justificationFiles) fd.append("justificationFile", file)
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
    <>
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
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4 overflow-y-auto px-6 py-4"
        >
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
            <TimeInput
              label="OT start"
              id="ot-start"
              value={startTime}
              onChange={setStartTime}
              defaultPeriod="AM"
            />
            <TimeInput
              label="OT end"
              id="ot-end"
              value={endTime}
              onChange={setEndTime}
              defaultPeriod="PM"
            />
          </div>

          {duration ? (
            <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2">
              <Clock className="h-3.5 w-3.5 text-primary" />
              <span className="text-xs text-muted-foreground">Duration</span>
              <span className="text-sm font-bold text-foreground">{duration}</span>
            </div>
          ) : timeError ? (
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

          <div className="space-y-1.5">
            <Label className={justificationError ? "text-destructive" : undefined}>
              Work area / justification <span className="text-destructive">*</span>
            </Label>
            <p className="text-xs text-muted-foreground">
              Upload a document or photo showing the area or tasks planned for this OT session. You can upload completion evidence after the session on the Overtime tab.
            </p>

            {/* Hidden file input (attach) */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
              multiple
              className="sr-only"
              onChange={(e) => { setPickerOpen(false); addJustificationFiles(e.target.files) }}
            />

            {/* Picker trigger + inline options */}
            <div ref={pickerRef} className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen((o) => !o)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-muted",
                  justificationError && "border-destructive",
                )}
              >
                <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">Add file…</span>
              </button>
              {pickerOpen && (
                <div className="absolute left-0 top-[calc(100%+4px)] z-50 flex gap-2 rounded-xl border border-border bg-background p-2 shadow-lg">
                  <button
                    type="button"
                    onClick={() => { setPickerOpen(false); setCameraOpen(true) }}
                    className="flex flex-col items-center gap-1.5 rounded-lg px-4 py-2.5 text-xs font-medium text-foreground hover:bg-muted"
                  >
                    <Camera className="h-5 w-5 text-muted-foreground" />
                    Take photo
                  </button>
                  <button
                    type="button"
                    onClick={() => { setPickerOpen(false); fileInputRef.current?.click() }}
                    className="flex flex-col items-center gap-1.5 rounded-lg px-4 py-2.5 text-xs font-medium text-foreground hover:bg-muted"
                  >
                    <FileUp className="h-5 w-5 text-muted-foreground" />
                    Attach file
                  </button>
                </div>
              )}
            </div>

            {/* Selected file list */}
            {justificationFiles.length > 0 && (
              <ul className="space-y-1">
                {justificationFiles.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-3 py-1.5 text-xs">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-foreground">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => removeJustificationFile(i)}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                      aria-label="Remove file"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {justificationError ? (
              <p className="text-xs text-destructive">At least one justification file is required.</p>
            ) : null}
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
    {cameraOpen && (
      <CameraCaptureModal
        onConfirm={(file) => { setCameraOpen(false); addJustificationFiles([file]) }}
        onCancel={() => setCameraOpen(false)}
      />
    )}
    </>
  )
}
