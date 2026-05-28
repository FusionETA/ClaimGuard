"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import {
  Clock,
  Coffee,
  LogIn,
  LogOut,
  PencilLine,
  Plus,
  Trash2,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { DateTimeField } from "@/components/attendance/datetime-field"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/components/ui/toaster"
import { cn } from "@/lib/utils"
import {
  editSessionAction,
  loadSessionBreaksAction,
  type EditSessionBreak,
} from "@/app/(employee)/employee/attendance/team/[employeeId]/actions"

type Props = {
  recordId: string
  employeeId: string
  initialTimeIn: string | null
  initialTimeOut: string | null
  triggerLabel?: string
  contextLabel?: string
}

const CLEAR_SENTINEL = "__CLEAR__"

function toLocalInput(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

function localInputToIso(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function diffMin(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null
  const a = new Date(startIso)
  const b = new Date(endIso)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000))
}

function fmtDur(min: number | null): string {
  if (min === null) return "—"
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

type EditableBreak = {
  uid: string // local id for React key
  id?: string // server id, if existing
  startedAt: string // local-datetime input value
  endedAt: string // local-datetime input value, "" = still open
}

let uidCounter = 0
const nextUid = () => `b${++uidCounter}`

export function SessionEditorDialog({
  recordId,
  employeeId,
  initialTimeIn,
  initialTimeOut,
  triggerLabel = "Edit session",
  contextLabel,
}: Props) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [timeIn, setTimeIn] = useState(toLocalInput(initialTimeIn))
  const [timeOut, setTimeOut] = useState(toLocalInput(initialTimeOut))
  const [clearTimeIn, setClearTimeIn] = useState(false)
  const [clearTimeOut, setClearTimeOut] = useState(false)
  const [breaks, setBreaks] = useState<EditableBreak[]>([])
  const [initialBreaks, setInitialBreaks] = useState<EditableBreak[]>([])
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [pending, startTransition] = useTransition()

  // Reset + load breaks ONLY when the dialog flips open. Intentionally
  // does NOT depend on `initialTimeIn` / `initialTimeOut` / `recordId`:
  // those props' references change on every parent re-render (e.g. when
  // RealtimeListener fires `router.refresh()` in response to an SSE
  // event), and depending on them here would wipe the user's in-progress
  // edits back to the saved values mid-typing — making the fields feel
  // "locked." Read them inside the effect so we get the values at the
  // moment of open, then leave them alone until the dialog closes.
  useEffect(() => {
    if (!open) return
    setTimeIn(toLocalInput(initialTimeIn))
    setTimeOut(toLocalInput(initialTimeOut))
    setClearTimeIn(false)
    setClearTimeOut(false)
    setReason("")
    setError(null)
    setLoading(true)
    loadSessionBreaksAction(recordId, employeeId)
      .then((result) => {
        if (result.error) {
          setError(result.error)
          setBreaks([])
          setInitialBreaks([])
          return
        }
        const loaded: EditableBreak[] = (result.breaks ?? []).map((b) => ({
          uid: nextUid(),
          id: b.id,
          startedAt: toLocalInput(b.startedAt),
          endedAt: b.endedAt ? toLocalInput(b.endedAt) : "",
        }))
        setBreaks(loaded)
        setInitialBreaks(loaded.map((b) => ({ ...b })))
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function updateBreak(uid: string, patch: Partial<EditableBreak>) {
    setBreaks((prev) =>
      prev.map((b) => (b.uid === uid ? { ...b, ...patch } : b)),
    )
  }

  function removeBreak(uid: string) {
    setBreaks((prev) => prev.filter((b) => b.uid !== uid))
  }

  function addBreak() {
    setBreaks((prev) => [
      ...prev,
      { uid: nextUid(), startedAt: "", endedAt: "" },
    ])
  }

  // Projected duration preview: clock-out − clock-in − sum of break mins.
  const projectedDuration = useMemo(() => {
    const inIso = clearTimeIn ? null : localInputToIso(timeIn)
    const outIso = clearTimeOut ? null : localInputToIso(timeOut)
    if (!inIso || !outIso) return null
    const worked = diffMin(inIso, outIso)
    if (worked === null) return null
    let breakMin = 0
    for (const b of breaks) {
      const s = localInputToIso(b.startedAt)
      const e = b.endedAt ? localInputToIso(b.endedAt) : outIso
      const d = diffMin(s, e)
      if (d !== null) breakMin += d
    }
    return Math.max(0, worked - breakMin)
  }, [timeIn, timeOut, breaks, clearTimeIn, clearTimeOut])

  // Decide whether anything changed (to enable/disable Save).
  const initialTimeInValue = toLocalInput(initialTimeIn)
  const initialTimeOutValue = toLocalInput(initialTimeOut)
  const timeInChanged =
    clearTimeIn ? initialTimeIn !== null : timeIn !== initialTimeInValue
  const timeOutChanged =
    clearTimeOut ? initialTimeOut !== null : timeOut !== initialTimeOutValue
  const breaksChanged = useMemo(() => {
    if (breaks.length !== initialBreaks.length) return true
    for (let i = 0; i < breaks.length; i++) {
      const a = breaks[i]
      const b = initialBreaks.find((x) => x.id && x.id === a.id)
      if (!b) return true
      if (a.startedAt !== b.startedAt || a.endedAt !== b.endedAt) return true
    }
    return false
  }, [breaks, initialBreaks])
  const anythingChanged = timeInChanged || timeOutChanged || breaksChanged

  function submit() {
    setError(null)
    if (!reason.trim()) {
      setError("Please add a reason for these changes.")
      return
    }
    // Build payload
    const tIn: string | null = clearTimeIn
      ? CLEAR_SENTINEL
      : timeIn
        ? localInputToIso(timeIn)
        : null
    const tOut: string | null = clearTimeOut
      ? CLEAR_SENTINEL
      : timeOut
        ? localInputToIso(timeOut)
        : null

    const payloadBreaks: EditSessionBreak[] = []
    for (const b of breaks) {
      const startedAt = localInputToIso(b.startedAt)
      if (!startedAt) {
        setError("Each break needs a start time.")
        return
      }
      const endedAt = b.endedAt ? localInputToIso(b.endedAt) : null
      payloadBreaks.push({ id: b.id, startedAt, endedAt })
    }

    startTransition(async () => {
      const res = await editSessionAction({
        recordId,
        employeeId,
        timeIn: tIn,
        timeOut: tOut,
        breaks: payloadBreaks,
        reason: reason.trim(),
      })
      if (res.error) {
        setError(res.error)
        toast({ title: res.error, variant: "error" })
        return
      }
      toast({ title: "Session saved.", variant: "success" })
      setOpen(false)
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <PencilLine className="h-3.5 w-3.5" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-primary/10 p-2.5 text-primary">
              <Clock className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <DialogTitle>Edit session</DialogTitle>
              <DialogDescription className="mt-1">
                {contextLabel
                  ? `${contextLabel}. Every change is captured in the audit log.`
                  : "Adjust clock-in, clock-out, and break times. Every change is captured in the audit log."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Loading session…
          </p>
        ) : (
          <div className="space-y-4">
            <TimeRow
              icon={<LogIn className="h-3.5 w-3.5" />}
              label="Clock in"
              tint="success"
              value={timeIn}
              onChange={(v) => {
                setTimeIn(v)
                setClearTimeIn(false)
              }}
              cleared={clearTimeIn}
              onClear={() => {
                setClearTimeIn(true)
                setTimeIn("")
              }}
              changed={timeInChanged}
            />

            {breaks.length === 0 ? (
              <p className="text-center text-[11px] italic text-muted-foreground">
                No breaks on this session
              </p>
            ) : (
              <div className="space-y-3">
                {breaks.map((b, idx) => (
                  <div
                    key={b.uid}
                    className="rounded-xl border border-amber-300/60 bg-amber-50/50 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800">
                        <Coffee className="h-3.5 w-3.5" /> Break {idx + 1}
                        {!b.id ? (
                          <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-900">
                            New
                          </span>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeBreak(b.uid)}
                        className="rounded-full p-1 text-amber-800 hover:bg-amber-200/60"
                        aria-label="Remove break"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div>
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Started at
                        </p>
                        <DateTimeField
                          value={b.startedAt}
                          onChange={(v) => updateBreak(b.uid, { startedAt: v })}
                          compact
                        />
                      </div>
                      <div>
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Ended at
                        </p>
                        <DateTimeField
                          value={b.endedAt}
                          onChange={(v) => updateBreak(b.uid, { endedAt: v })}
                          compact
                        />
                        {b.endedAt === "" ? (
                          <p className="mt-1 text-[10px] text-amber-700">
                            (Leave blank for still-open break)
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addBreak}
              className="w-full gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" /> Add break
            </Button>

            <TimeRow
              icon={<LogOut className="h-3.5 w-3.5" />}
              label="Clock out"
              tint="destructive"
              value={timeOut}
              onChange={(v) => {
                setTimeOut(v)
                setClearTimeOut(false)
              }}
              cleared={clearTimeOut}
              onClear={() => {
                setClearTimeOut(true)
                setTimeOut("")
              }}
              changed={timeOutChanged}
            />

            {projectedDuration !== null ? (
              <div
                className={cn(
                  "rounded-xl border px-3 py-2 text-xs",
                  anythingChanged
                    ? "border-primary/40 bg-primary/5 text-primary"
                    : "border-border/60 bg-surface-low text-muted-foreground",
                )}
              >
                <span className="font-semibold">Projected worked time:</span>{" "}
                {fmtDur(projectedDuration)}
              </div>
            ) : null}

            <label className="block space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Reason (required)
              </span>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. employee forgot to end break, on-site confirmed"
                rows={2}
              />
            </label>

            {error ? (
              <p className="text-xs font-semibold text-destructive">{error}</p>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2 border-t border-border/60 pt-3 sm:flex-row-reverse">
          <Button
            type="button"
            size="lg"
            disabled={pending || loading || !anythingChanged}
            onClick={submit}
            className="flex-1 shadow-sm"
          >
            {pending ? "Saving…" : "Save changes"}
          </Button>
          <DialogClose asChild>
            <Button
              type="button"
              size="lg"
              variant="outline"
              disabled={pending}
              className="flex-1 border-2"
            >
              Cancel
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TimeRow({
  icon,
  label,
  tint,
  value,
  onChange,
  cleared,
  onClear,
  changed,
}: {
  icon: React.ReactNode
  label: string
  tint: "success" | "destructive"
  value: string
  onChange: (next: string) => void
  cleared: boolean
  onClear: () => void
  changed: boolean
}) {
  return (
    <div
      className={cn(
        "space-y-2 rounded-xl border p-3 transition-colors",
        changed
          ? tint === "success"
            ? "border-success/40 bg-success/5"
            : "border-destructive/40 bg-destructive/5"
          : "border-border/60",
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span
          className={cn(
            "rounded-lg p-1",
            tint === "success"
              ? "bg-success/10 text-success"
              : "bg-destructive/10 text-destructive",
          )}
        >
          {icon}
        </span>
        {label}
        {changed ? (
          <span
            className={cn(
              "ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
              tint === "success"
                ? "bg-success/15 text-success"
                : "bg-destructive/15 text-destructive",
            )}
          >
            Edited
          </span>
        ) : null}
      </div>
      {cleared ? (
        <div className="flex items-center justify-between rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="italic">Cleared</span>
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-[11px] font-semibold text-primary hover:underline"
          >
            Undo
          </button>
        </div>
      ) : (
        <>
          <DateTimeField value={value} onChange={onChange} compact />
          {value ? (
            <button
              type="button"
              onClick={onClear}
              className="text-[11px] font-semibold text-muted-foreground hover:text-destructive"
            >
              Clear
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
