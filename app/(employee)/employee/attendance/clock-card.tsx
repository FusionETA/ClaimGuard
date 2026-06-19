"use client"

import { useActionState, useEffect, useRef, useState, useTransition } from "react"
import { createPortal } from "react-dom"
import { AlertTriangle, Camera, Coffee, Fingerprint, LogOut, RotateCcw, X } from "lucide-react"

import { Card } from "@/components/attendance/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  AttendanceProjectView,
  AttendanceRecordView,
  ClockEventLite,
} from "@/modules/attendance/domain/models"
import { checkGeofence, type GeofenceCheck } from "@/lib/geo"
import { parseWorkingDays, isoWeekday } from "@/modules/attendance/domain/hours-summary"

import {
  checkProjectHolidayAction,
  clockInAction,
  clockOutAction,
  endBreakAction,
  startBreakAction,
  type ClockInState,
  updateTodayRemarkAction,
} from "./actions"
import { ClockOutSummaryDialog } from "./clock-out-summary-dialog"

/**
 * Best-effort coord refresh on click. Awaits at most `timeoutMs` for a
 * fresh fix and accepts cached fixes up to `maxAgeMs` old, so the
 * button doesn't block on a slow GPS lock when the watcher already has
 * a usable position. The watcher (see `useEffect` below) keeps
 * `employeeCoords` warm; this is just a top-up before submitting.
 */
async function attachCoords(
  formData: FormData,
  timeoutMs = 1500,
  maxAgeMs = 30_000,
): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return
  try {
    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        timeout: timeoutMs,
        maximumAge: maxAgeMs,
      })
    })
    formData.set("lat", String(position.coords.latitude))
    formData.set("lng", String(position.coords.longitude))
  } catch {
    // GPS denied/unavailable/timed out — the caller will fall back to
    // the watched `employeeCoords` if available.
  }
}

function readCoordsFrom(formData: FormData): { lat: number; lng: number } | null {
  const lat = parseFloat(String(formData.get("lat") ?? ""))
  const lng = parseFloat(String(formData.get("lng") ?? ""))
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
}

/**
 * Resolve coords for a submission as quickly as possible.
 *
 * The watcher already keeps `watched` warm (see watchPosition effect),
 * so when it's available we skip `getCurrentPosition` entirely and the
 * button submits with zero GPS wait. Only when there's no watched fix
 * do we fall back to a short-timeout `getCurrentPosition` call.
 */
async function resolveCoordsForSubmit(
  formData: FormData,
  watched: { lat: number; lng: number } | null,
): Promise<void> {
  if (readCoordsFrom(formData) !== null) return
  if (watched) {
    formData.set("lat", String(watched.lat))
    formData.set("lng", String(watched.lng))
    return
  }
  await attachCoords(formData)
}

function fallbackCoordsFromState(
  formData: FormData,
  fallback: { lat: number; lng: number } | null,
): void {
  if (readCoordsFrom(formData) !== null) return
  if (!fallback) return
  formData.set("lat", String(fallback.lat))
  formData.set("lng", String(fallback.lng))
}

type BreakKind = "BREAK_START" | "BREAK_END"

type PendingAction = {
  formData: FormData
  fence: GeofenceCheck
  kind: "CLOCK_IN" | "CLOCK_OUT" | BreakKind
  projectName: string | null
}

type Props = {
  state: "IN" | "OUT"
  projects: AttendanceProjectView[]
  activeProject: string | null
  activeLocation: string | null
  activeProjectLat: number | null
  activeProjectLng: number | null
  geofenceRadiusMeters: number
  now: string
  onBreak: boolean
  /** ISO timestamp of the currently-open break, if any (for the "On break since…" label). */
  currentBreakStartedAt: string | null
  /** When true (Hourly Workers), the clock-in flow gates on a selfie capture. */
  requiresSelfieOnClockIn: boolean
  /** When false (policy says geofence not required), skip GPS capture and
   *  treat every clock event as "within radius" — no location is sent. */
  enforceGeofence: boolean
  /** Master switch from the policy: when true, the client captures GPS
   *  for every attendance event regardless of geofence enforcement. The
   *  per-event flags below decide which events actually persist coords
   *  server-side (the watcher runs either way; we pass the coords up
   *  per event based on the flag). */
  captureLocationEnabled: boolean
  /** Per-event capture flags from the policy. The client passes coords
   *  to the server action only when both `captureLocationEnabled` AND
   *  the matching flag are true (or when geofence enforcement requires
   *  it). All default true. */
  captureLocationOnClockIn: boolean
  captureLocationOnClockOut: boolean
  captureLocationOnBreakStart: boolean
  captureLocationOnBreakEnd: boolean
  /** Today's full attendance record — drives the clock-out confirmation dialog. */
  todayRecord: AttendanceRecordView | null
  /** Most recent rejected clock-in/clock-out for today, if any. When present
   *  a warning banner is rendered above the clock buttons explaining why the
   *  previous event was rejected and prompting the employee to retry. */
  latestRejection: ClockEventLite | null
  /** Set when today has a PENDING clock-in/out/break approval. Disables
   *  the next-event button(s) until the supervisor reviews — clock-in
   *  is never disabled by this flag (it's the first event of the day,
   *  there's no prior). */
  pendingApproval: { id: string; kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK" } | null
}

function ClockInButton({ pending }: { pending: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="group flex w-full flex-col items-center justify-center rounded-[28px] border border-border/70 bg-card/94 py-6 shadow-ambient backdrop-blur-sm transition hover:bg-card active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="relative mb-2 flex h-20 w-20 items-center justify-center rounded-full bg-primary shadow-panel">
        {!pending ? (
          <div className="absolute h-20 w-20 animate-ping2 rounded-full bg-primary opacity-20" />
        ) : null}
        <Fingerprint className="h-10 w-10 text-primary-foreground" />
      </div>
      <p className="text-sm font-bold text-primary">
        {pending ? "Clocking in…" : "Tap to Clock In"}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Pending supervisor approval after tap
      </p>
    </button>
  )
}

function ClockOutButton({
  pending,
  blocked,
}: {
  pending: boolean
  blocked?: boolean
}) {
  return (
    <button
      type="submit"
      disabled={pending || blocked}
      className="flex w-full flex-col items-center justify-center rounded-[28px] border border-border/70 bg-card/94 py-5 shadow-ambient backdrop-blur-sm transition hover:bg-card active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
        <LogOut className="h-6 w-6" />
      </div>
      <p className="text-sm font-bold text-destructive">
        {pending ? "Clocking out…" : "Clock Out"}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {blocked ? "Waiting on supervisor" : "End shift"}
      </p>
    </button>
  )
}

function BreakStartButton({
  pending,
  blocked,
}: {
  pending: boolean
  blocked?: boolean
}) {
  return (
    <button
      type="submit"
      disabled={pending || blocked}
      className="flex w-full flex-col items-center justify-center rounded-[28px] border border-border/70 bg-card/94 py-5 shadow-ambient backdrop-blur-sm transition hover:bg-card active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
        <Coffee className="h-6 w-6" />
      </div>
      <p className="text-sm font-bold text-foreground">
        {pending ? "Saving…" : "Start Break"}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {blocked ? "Waiting on supervisor" : "Pauses your shift"}
      </p>
    </button>
  )
}

function BreakEndButton({
  pending,
  blocked,
}: {
  pending: boolean
  blocked?: boolean
}) {
  return (
    <button
      type="submit"
      disabled={pending || blocked}
      className="flex w-full flex-col items-center justify-center rounded-[28px] border border-amber-300 bg-amber-50 py-5 shadow-ambient backdrop-blur-sm transition hover:bg-amber-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500 text-white">
        <Coffee className="h-6 w-6" />
      </div>
      <p className="text-sm font-bold text-amber-900">
        {pending ? "Saving…" : "End Break"}
      </p>
      <p className="mt-0.5 text-[11px] text-amber-800">
        {blocked ? "Waiting on supervisor" : "Resumes your shift"}
      </p>
    </button>
  )
}

export function ClockCard({
  state,
  projects,
  activeProject,
  activeLocation,
  activeProjectLat,
  activeProjectLng,
  geofenceRadiusMeters,
  now,
  onBreak,
  currentBreakStartedAt,
  requiresSelfieOnClockIn,
  enforceGeofence,
  captureLocationEnabled,
  captureLocationOnClockIn,
  captureLocationOnClockOut,
  captureLocationOnBreakStart,
  captureLocationOnBreakEnd,
  todayRecord,
  latestRejection,
  pendingApproval,
}: Props) {
  // GPS watcher runs whenever the policy enforces geofence OR allows
  // location capture for any event. We always have coords ready; per-
  // event flags below decide whether to actually attach them.
  const captureAny =
    enforceGeofence ||
    (captureLocationEnabled &&
      (captureLocationOnClockIn ||
        captureLocationOnClockOut ||
        captureLocationOnBreakStart ||
        captureLocationOnBreakEnd))
  const [rejectionDismissed, setRejectionDismissed] = useState(false)
  const [selected, setSelected] = useState("")
  const [result, formAction] = useActionState<ClockInState, FormData>(
    clockInAction,
    {},
  )
  const [isPending, startTransition] = useTransition()
  const [isClockOutPending, startClockOutTransition] = useTransition()
  // Pending clock-out: the formData has been built (coords resolved,
  // off-site remark captured if needed) but the server hasn't been
  // called yet. The summary dialog opens to let the employee review and
  // optionally attach an adjustment request; only Looks good / Submit
  // request actually commits. Closing the dialog cancels the clock-out.
  const [clockOutDraft, setClockOutDraft] = useState<{
    formData: FormData
  } | null>(null)
  const [clockOutCommitError, setClockOutCommitError] = useState<string | null>(
    null,
  )

  function prepareClockOut(formData: FormData) {
    setClockOutCommitError(null)
    setClockOutDraft({ formData })
  }

  function cancelClockOutDraft() {
    if (isClockOutPending) return
    setClockOutDraft(null)
    setClockOutCommitError(null)
  }

  function commitClockOut(adjustmentRequest: string | null) {
    if (!clockOutDraft) return
    const fd = clockOutDraft.formData
    startClockOutTransition(async () => {
      const result = await clockOutAction(fd)
      if (result.error) {
        setClockOutCommitError(result.error)
        return
      }
      if (adjustmentRequest && result.summary?.recordId) {
        const remarkForm = new FormData()
        remarkForm.set("recordId", result.summary.recordId)
        remarkForm.set("remark", adjustmentRequest)
        const remarkResult = await updateTodayRemarkAction({}, remarkForm)
        if (remarkResult.error) {
          // Clock-out already committed; just surface the remark error.
          setClockOutCommitError(remarkResult.error)
          return
        }
      }
      setClockOutDraft(null)
      setClockOutCommitError(null)
    })
  }
  const [isBreakPending, startBreakTransition] = useTransition()
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [remark, setRemark] = useState("")
  const [remarkError, setRemarkError] = useState<string | null>(null)
  // Guards against a second tap firing handleClockIn/Out/Break while the
  // first is still awaiting GPS — without this, the second resolution
  // wipes any remark the user has typed and reopens the dismissed popup.
  const [isResolving, setIsResolving] = useState(false)
  const [employeeCoords, setEmployeeCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [gpsState, setGpsState] = useState<"idle" | "locating" | "ok" | "denied">("idle")
  /// FormData held in flight while the selfie modal is open. Once the
  /// employee confirms the photo, the data URL is attached and the rest of
  /// the clock-in flow (geofence check / remark / dispatch) runs.
  const [selfiePending, setSelfiePending] = useState<FormData | null>(null)
  /// Client-side validation message for the project picker. Cleared as
  /// soon as the user picks a project.
  const [projectError, setProjectError] = useState<string | null>(null)
  /// When the employee tries to clock in on a rest day or public holiday,
  /// we pause and show a warning dialog. The formData is held here so we
  /// can resume the flow if they confirm.
  const [restDayWarning, setRestDayWarning] = useState<{
    formData: FormData
    reason: string
  } | null>(null)

  useEffect(() => {
    // Policy opt-out: skip GPS entirely when neither geofence nor
    // location capture is on for ANY event. Saves the permission
    // prompt + watcher cost for orgs that don't use either.
    //
    // The setGpsState calls here are intentional — the effect kicks
    // off an async permission/location flow whose final state has to
    // be reflected somewhere. Refactoring to derived state would
    // require a Suspense-shaped wrapper around the geolocation API,
    // which doesn't exist as a React resource.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!captureAny) {
      setGpsState("ok")
      return
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGpsState("denied")
      return
    }
    setGpsState("locating")
    /* eslint-enable react-hooks/set-state-in-effect */
    // Fast first read — accept any cached fix the OS already has so the
    // button feels ready almost immediately. Falls through silently if
    // the cache is empty; the watcher below will catch the fresh fix.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setEmployeeCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setGpsState("ok")
      },
      () => {
        // ignore — `watchPosition` handles the eventual error/denied state
      },
      { enableHighAccuracy: false, timeout: 2000, maximumAge: Infinity },
    )
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setEmployeeCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setGpsState("ok")
      },
      () => setGpsState("denied"),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 30000 },
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [captureAny])

  const targetProjectCoords: { latitude: number | null; longitude: number | null } | null =
    state === "OUT"
      ? (() => {
          const p = projects.find((proj) => proj.id === selected)
          return p ? { latitude: p.latitude, longitude: p.longitude } : null
        })()
      : { latitude: activeProjectLat, longitude: activeProjectLng }
  const liveFence: GeofenceCheck = enforceGeofence
    ? checkGeofence(
        employeeCoords,
        targetProjectCoords ?? { latitude: null, longitude: null },
        geofenceRadiusMeters,
      )
    : { withinRadius: true, distanceMeters: null, reason: "ok" }

  function dispatch(action: PendingAction) {
    if (action.kind === "CLOCK_IN") {
      startTransition(() => formAction(action.formData))
    } else if (action.kind === "CLOCK_OUT") {
      prepareClockOut(action.formData)
    } else if (action.kind === "BREAK_START") {
      startBreakTransition(() => startBreakAction(action.formData))
    } else {
      startBreakTransition(() => endBreakAction(action.formData))
    }
  }

  async function handleClockIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (isResolving || pendingAction || selfiePending || restDayWarning) return
    if (!selected) {
      setProjectError("Please select a project before clocking in.")
      return
    }
    setProjectError(null)
    const formData = new FormData(e.currentTarget)
    await checkRestDayAndProceed(formData)
  }

  async function checkRestDayAndProceed(formData: FormData) {
    const project = projects.find((p) => p.id === selected) ?? null
    const today = new Date()
    const todayWeekday = isoWeekday(today)
    const workingDays = parseWorkingDays(project?.workingDays ?? null)
    const isRestDay = !workingDays.has(todayWeekday)

    if (isRestDay) {
      setRestDayWarning({ formData, reason: "rest day" })
      return
    }

    if (project?.id) {
      const holidayName = await checkProjectHolidayAction(project.id)
      if (holidayName) {
        setRestDayWarning({ formData, reason: `public holiday (${holidayName})` })
        return
      }
    }

    await continueClockIn(formData)
  }

  async function continueClockIn(formData: FormData) {
    if (requiresSelfieOnClockIn && !formData.get("selfie")) {
      setSelfiePending(formData)
      return
    }
    await proceedClockIn(formData)
  }

  async function proceedClockIn(formData: FormData) {
    setIsResolving(true)
    try {
      const project = projects.find((p) => p.id === selected) ?? null
      // Capture coords whenever geofence is enforced OR the policy
      // wants location persisted for clock-in events. The server is
      // the source of truth — it'll only WRITE the coords when the
      // per-event flag is true; sending them is harmless otherwise.
      const captureForThisEvent =
        enforceGeofence || (captureLocationEnabled && captureLocationOnClockIn)
      if (captureForThisEvent) {
        await resolveCoordsForSubmit(formData, employeeCoords)
      }
      const fence: GeofenceCheck = enforceGeofence
        ? checkGeofence(
            readCoordsFrom(formData),
            project ?? { latitude: null, longitude: null },
            geofenceRadiusMeters,
          )
        : { withinRadius: true, distanceMeters: null, reason: "ok" }
      if (fence.withinRadius) {
        startTransition(() => formAction(formData))
        return
      }
      setRemark("")
      setRemarkError(null)
      setPendingAction({
        formData,
        fence,
        kind: "CLOCK_IN",
        projectName: project?.name ?? null,
      })
    } finally {
      setIsResolving(false)
    }
  }

  function onSelfieConfirmed(dataUrl: string) {
    if (!selfiePending) return
    selfiePending.set("selfie", dataUrl)
    const fd = selfiePending
    setSelfiePending(null)
    void proceedClockIn(fd)
  }

  function onSelfieCancelled() {
    setSelfiePending(null)
  }

  async function handleClockOut(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (isResolving || pendingAction) return
    setIsResolving(true)
    try {
      const formData = new FormData(e.currentTarget)
      const captureForThisEvent =
        enforceGeofence || (captureLocationEnabled && captureLocationOnClockOut)
      if (captureForThisEvent) {
        await resolveCoordsForSubmit(formData, employeeCoords)
      }
      const fence: GeofenceCheck = enforceGeofence
        ? checkGeofence(
            readCoordsFrom(formData),
            { latitude: activeProjectLat, longitude: activeProjectLng },
            geofenceRadiusMeters,
          )
        : { withinRadius: true, distanceMeters: null, reason: "ok" }
      if (fence.withinRadius) {
        prepareClockOut(formData)
        return
      }
      setRemark("")
      setRemarkError(null)
      setPendingAction({
        formData,
        fence,
        kind: "CLOCK_OUT",
        projectName: activeProject,
      })
    } finally {
      setIsResolving(false)
    }
  }

  async function handleBreak(
    e: React.FormEvent<HTMLFormElement>,
    kind: BreakKind,
  ) {
    e.preventDefault()
    if (isResolving || pendingAction) return
    setIsResolving(true)
    try {
      const formData = new FormData(e.currentTarget)
      const eventFlag =
        kind === "BREAK_START"
          ? captureLocationOnBreakStart
          : captureLocationOnBreakEnd
      const captureForThisEvent =
        enforceGeofence || (captureLocationEnabled && eventFlag)
      if (captureForThisEvent) {
        await resolveCoordsForSubmit(formData, employeeCoords)
      }
      const fence: GeofenceCheck = enforceGeofence
        ? checkGeofence(
            readCoordsFrom(formData),
            { latitude: activeProjectLat, longitude: activeProjectLng },
            geofenceRadiusMeters,
          )
        : { withinRadius: true, distanceMeters: null, reason: "ok" }
      if (fence.withinRadius) {
        startBreakTransition(() =>
          kind === "BREAK_START"
            ? startBreakAction(formData)
            : endBreakAction(formData),
        )
        return
      }
      setRemark("")
      setRemarkError(null)
      setPendingAction({
        formData,
        fence,
        kind,
        projectName: activeProject,
      })
    } finally {
      setIsResolving(false)
    }
  }

  function confirmRemark() {
    if (!pendingAction) return
    const trimmed = remark.trim()
    if (!trimmed) {
      setRemarkError("A remark is required when you're off-site.")
      return
    }
    pendingAction.formData.set("notes", trimmed)
    dispatch(pendingAction)
    setRemark("")
    setRemarkError(null)
    setPendingAction(null)
  }

  function cancelRemark() {
    setPendingAction(null)
    setRemark("")
    setRemarkError(null)
  }

  const formattedTime = new Date(now).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  })

  return (
    <>
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Right now
          </p>
          <p className="mt-0.5 text-3xl font-extrabold text-foreground">{formattedTime}</p>
        </div>
        {state === "IN" && activeProject ? (
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Project
            </p>
            <p className="mt-0.5 text-sm font-bold text-foreground">{activeProject}</p>
            {activeLocation ? (
              <a
                href={`https://www.google.com/maps?q=${encodeURIComponent(activeLocation)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block text-[11px] font-semibold text-primary underline-offset-2 hover:underline"
              >
                📍 {activeLocation}
              </a>
            ) : null}
            {enforceGeofence ? (
              <DistanceIndicator
                gpsState={gpsState}
                fence={liveFence}
                radius={geofenceRadiusMeters}
                employeeCoords={employeeCoords}
                projectCoords={targetProjectCoords}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {latestRejection && !rejectionDismissed ? (
        <div className="mb-4 rounded-[20px] border border-destructive/40 bg-destructive/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-destructive">
                {latestRejection.kind === "CLOCK_IN"
                  ? "Your clock-in was rejected"
                  : "Your clock-out was rejected"}
              </p>
              <p className="mt-1 text-xs text-destructive/90">
                Rejected at{" "}
                {new Date(latestRejection.eventAt).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {latestRejection.reviewerName
                  ? ` by ${latestRejection.reviewerName}`
                  : ""}
                {". Please "}
                {latestRejection.kind === "CLOCK_IN"
                  ? "clock in again"
                  : "clock out again"}
                {" when ready."}
              </p>
              {latestRejection.reviewNotes ? (
                <p className="mt-2 rounded-[10px] bg-destructive/15 px-3 py-2 text-xs text-destructive">
                  <span className="font-semibold">Reason:</span>{" "}
                  {latestRejection.reviewNotes}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setRejectionDismissed(true)}
              className="rounded-full p-1 text-destructive/70 hover:bg-destructive/15"
              aria-label="Dismiss rejection notice"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      {pendingApproval && state === "IN" ? (
        <div className="mb-4 rounded-[20px] border border-amber-300/60 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-amber-900">
                Waiting on supervisor approval
              </p>
              <p className="mt-1 text-xs text-amber-800">
                Your{" "}
                {pendingApproval.kind === "CLOCK_IN"
                  ? "clock-in"
                  : pendingApproval.kind === "CLOCK_OUT"
                    ? "clock-out"
                    : "break"}{" "}
                is still pending review. The next clock or break action
                will unlock once your supervisor approves it.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {state === "OUT" ? (
        <form onSubmit={handleClockIn} className="space-y-3">
          <div>
            <label
              htmlFor="projectId"
              className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Project
            </label>
            <div className="mt-1">
              <Select
                name="projectId"
                value={selected}
                onValueChange={(value) => {
                  setSelected(value)
                  setProjectError(null)
                }}
                disabled={projects.length === 0}
              >
                <SelectTrigger id="projectId">
                  <SelectValue placeholder={projects.length === 0 ? "No projects available" : "Select a project…"} />
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
            {projects.length === 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Ask your admin to assign you to a project.
              </p>
            ) : null}
            {projectError ? (
              <p className="mt-1 text-[11px] font-semibold text-destructive">
                {projectError}
              </p>
            ) : null}
            {selected && enforceGeofence ? (
              <div className="mt-2">
                <DistanceIndicator
                gpsState={gpsState}
                fence={liveFence}
                radius={geofenceRadiusMeters}
                employeeCoords={employeeCoords}
                projectCoords={targetProjectCoords}
              />
              </div>
            ) : null}
          </div>
          <ClockInButton pending={isPending || isResolving} />
          {requiresSelfieOnClockIn ? (
            <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <Camera className="h-3 w-3" />
              You&apos;ll be asked for a selfie before clocking in
            </p>
          ) : null}
          {result.error ? (
            <p className="text-xs font-semibold text-destructive">{result.error}</p>
          ) : null}
        </form>
      ) : onBreak ? (
        <div className="space-y-3">
          <p className="rounded-2xl bg-amber-50 px-4 py-3 text-center text-xs font-semibold text-amber-900">
            On break since{" "}
            {currentBreakStartedAt
              ? new Date(currentBreakStartedAt).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "—"}
            . Clock out is disabled until you end the break.
          </p>
          <form onSubmit={(e) => handleBreak(e, "BREAK_END")}>
            <BreakEndButton
              pending={isBreakPending || isResolving}
              blocked={pendingApproval !== null}
            />
          </form>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <form onSubmit={(e) => handleBreak(e, "BREAK_START")}>
            <BreakStartButton
              pending={isBreakPending || isResolving}
              blocked={pendingApproval !== null}
            />
          </form>
          <form onSubmit={handleClockOut}>
            <ClockOutButton
              pending={isClockOutPending || isResolving}
              blocked={pendingApproval !== null}
            />
          </form>
        </div>
      )}

      {pendingAction ? (
        <RemarkPanel
          fence={pendingAction.fence}
          projectName={pendingAction.projectName}
          remark={remark}
          onChange={setRemark}
          onConfirm={confirmRemark}
          onCancel={cancelRemark}
          error={remarkError}
        />
      ) : null}

      {selfiePending ? (
        <SelfieCaptureModal
          onConfirm={onSelfieConfirmed}
          onCancel={onSelfieCancelled}
        />
      ) : null}

      {restDayWarning ? (
        <RestDayWarningDialog
          reason={restDayWarning.reason}
          onConfirm={() => {
            const fd = restDayWarning.formData
            setRestDayWarning(null)
            void continueClockIn(fd)
          }}
          onCancel={() => setRestDayWarning(null)}
        />
      ) : null}
    </Card>
    <ClockOutSummaryDialog
      todayRecord={clockOutDraft ? todayRecord : null}
      pending={isClockOutPending}
      error={clockOutCommitError}
      onConfirm={commitClockOut}
      onClose={cancelClockOutDraft}
    />
    </>
  )
}

function SelfieCaptureModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: (dataUrl: string) => void
  onCancel: () => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [captured, setCaptured] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  // Portal target — only available on the client. Without this the modal
  // renders inside the ClockCard, which can be clipped by parent
  // overflow / transformed by ancestor styles, causing the bottom of the
  // dialog to be hidden behind the card below.
  const [mounted, setMounted] = useState(false)
  // Canonical "did this client component hydrate yet" pattern — the
  // setState-in-effect rule flags it but the only React-blessed
  // alternative (`useSyncExternalStore` with a server snapshot)
  // adds machinery that doesn't pull weight for a one-shot mount flag.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    let cancelled = false
    let activeStream: MediaStream | null = null
    async function start() {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setError("Camera not supported on this device.")
        setStarting(false)
        return
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
          audio: false,
        })
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        activeStream = s
        setStream(s)
        if (videoRef.current) {
          videoRef.current.srcObject = s
          await videoRef.current.play().catch(() => undefined)
        }
      } catch (err) {
        setError(
          err instanceof Error && err.name === "NotAllowedError"
            ? "Camera permission denied. Enable it in your browser settings to clock in."
            : "Couldn't open the camera. Try again.",
        )
      } finally {
        if (!cancelled) setStarting(false)
      }
    }
    void start()
    return () => {
      cancelled = true
      if (activeStream) activeStream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function capture() {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    const w = video.videoWidth || 720
    const h = video.videoHeight || 720
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    // Mirror the front-facing capture so the saved photo matches what the
    // employee sees in the preview (browsers flip the live video, not the
    // canvas frame).
    ctx.save()
    ctx.translate(w, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0, w, h)
    ctx.restore()
    setCaptured(canvas.toDataURL("image/jpeg", 0.85))
  }

  function retake() {
    setCaptured(null)
  }

  function confirm() {
    if (!captured) return
    if (stream) stream.getTracks().forEach((t) => t.stop())
    onConfirm(captured)
  }

  if (!mounted) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="my-auto w-full max-w-md overflow-hidden rounded-[24px] border border-border/60 bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div>
            <p className="text-sm font-bold text-foreground">Take a selfie</p>
            <p className="text-[11px] text-muted-foreground">
              Required for hourly worker clock-in
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-muted"
            aria-label="Cancel selfie"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative aspect-square w-full bg-black">
          {error ? (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm font-semibold text-destructive">
              {error}
            </div>
          ) : captured ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={captured}
              alt="Selfie preview"
              className="h-full w-full object-cover"
            />
          ) : (
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="h-full w-full -scale-x-100 object-cover"
            />
          )}
          {starting && !error ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-xs font-semibold text-white">
              Starting camera…
            </div>
          ) : null}
          <canvas ref={canvasRef} className="hidden" />
        </div>

        <div className="flex gap-2 border-t border-border/60 p-3">
          {captured ? (
            <>
              <button
                type="button"
                onClick={retake}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-[14px] border border-border/70 bg-card py-2.5 text-xs font-bold text-foreground hover:bg-muted"
              >
                <RotateCcw className="h-4 w-4" />
                Retake
              </button>
              <button
                type="button"
                onClick={confirm}
                className="flex-1 rounded-[14px] bg-primary py-2.5 text-xs font-bold text-primary-foreground hover:bg-primary/90"
              >
                Use this photo
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={capture}
              disabled={starting || !!error}
              className="flex flex-1 items-center justify-center gap-2 rounded-[14px] bg-primary py-2.5 text-xs font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Camera className="h-4 w-4" />
              Capture
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function RemarkPanel({
  fence,
  projectName,
  remark,
  onChange,
  onConfirm,
  onCancel,
  error,
}: {
  fence: GeofenceCheck
  projectName: string | null
  remark: string
  onChange: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
  error: string | null
}) {
  const heading =
    fence.reason === "no_gps"
      ? "Location unavailable — add a remark"
      : fence.reason === "no_project_coords"
        ? "Project has no coordinates set — add a remark"
        : `You're ${fence.distanceMeters ? Math.round(fence.distanceMeters) : "?"}m from ${projectName ?? "the project"}`

  return (
    <div className="mt-4 rounded-[20px] border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-bold text-amber-900">{heading}</p>
      <p className="mt-1 text-xs text-amber-800">
        Add a remark explaining why you're off-site. Your approver will see it.
      </p>
      <textarea
        value={remark}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Stuck in traffic, on-site at client office"
        rows={3}
        // 16px (`text-base`) on mobile prevents iOS Safari from
        // auto-zooming the viewport when the textarea is focused —
        // and Safari never zooms back out on blur, so a 14px input
        // leaves the whole page stuck at the zoomed level after the
        // user clicks Confirm/Cancel. Tighten back to 14px on sm+
        // where the iOS rule doesn't apply.
        className="mt-2 block w-full rounded-[14px] border border-amber-300 bg-white px-3 py-2 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 sm:text-sm"
      />
      {error ? <p className="mt-1 text-xs font-semibold text-destructive">{error}</p> : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-[14px] border border-amber-300 bg-white py-2 text-xs font-bold text-amber-900 hover:bg-amber-100"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 rounded-[14px] bg-amber-500 py-2 text-xs font-bold text-white hover:bg-amber-600"
        >
          Confirm with remark
        </button>
      </div>
    </div>
  )
}

function DistanceIndicator({
  gpsState,
  fence,
  radius,
  employeeCoords,
  projectCoords,
}: {
  gpsState: "idle" | "locating" | "ok" | "denied"
  fence: GeofenceCheck
  radius: number
  employeeCoords: { lat: number; lng: number } | null
  projectCoords: { latitude: number | null; longitude: number | null } | null
}) {
  const fmt = (n: number | null | undefined) =>
    typeof n === "number" ? n.toFixed(6) : "—"
  const debug = (
    <div className="mt-1 space-y-0.5 text-left text-[10px] font-mono text-muted-foreground">
      <p>You: {employeeCoords ? `${fmt(employeeCoords.lat)}, ${fmt(employeeCoords.lng)}` : "—"}</p>
      <p>
        Site:{" "}
        {projectCoords
          ? `${fmt(projectCoords.latitude)}, ${fmt(projectCoords.longitude)}`
          : "—"}
      </p>
    </div>
  )

  let status: React.ReactNode
  if (gpsState === "locating" || gpsState === "idle") {
    status = (
      <p className="text-[11px] font-semibold text-muted-foreground">Locating you…</p>
    )
  } else if (gpsState === "denied" || fence.reason === "no_gps") {
    status = (
      <p className="text-[11px] font-semibold text-amber-700">⚠ Location unavailable</p>
    )
  } else if (fence.reason === "no_project_coords") {
    status = (
      <p className="text-[11px] font-semibold text-muted-foreground">
        Project has no geofence set
      </p>
    )
  } else {
    const meters = Math.round(fence.distanceMeters ?? 0)
    const display = meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${meters}m`
    status = fence.withinRadius ? (
      <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        On site · {display} away (within {radius}m)
      </p>
    ) : (
      <p className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        Off site · {display} away (limit {radius}m)
      </p>
    )
  }

  return (
    <div>
      {status}
      {debug}
    </div>
  )
}

function RestDayWarningDialog({
  reason,
  onConfirm,
  onCancel,
}: {
  reason: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-3xl border border-border/60 bg-card p-6 shadow-xl">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-tertiary/15">
          <AlertTriangle className="h-6 w-6 text-tertiary" />
        </div>
        <h2 className="text-base font-bold text-foreground">
          Clock in on a {reason}?
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Today is a <span className="font-semibold text-foreground">{reason}</span>. Are you
          sure you want to clock in?
        </p>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-2xl border border-border/60 py-2.5 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-2xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
          >
            Yes, clock in
          </button>
        </div>
      </div>
    </div>
  )
}

export type ClockCardProps = Props
