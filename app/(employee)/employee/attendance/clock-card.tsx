"use client"

import { useActionState, useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { createPortal } from "react-dom"
import { AlertTriangle, Camera, Coffee, Fingerprint, Loader2, LogOut, MapPin, RotateCcw, X } from "lucide-react"

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
import type { ProjectGeoLocation } from "@/modules/organization/domain/models"
import {
  checkGeofence,
  checkGeofenceMulti,
  formatDistance,
  type GeofenceCheck,
} from "@/lib/geo"
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
import { ElapsedTimer } from "./elapsed-timer"

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

/**
 * The server throws this exact copy when the caller's IP fails the
 * project's allowedIps whitelist (see
 * `modules/attendance/application/services/employee-attendance.service.ts`).
 * A substring check is defensive against future wrapping ("Server: ...").
 */
function isOffNetworkError(msg: string | undefined): boolean {
  if (!msg) return false
  return msg.toLowerCase().includes("office network")
}

type PendingAction = {
  formData: FormData
  fence: GeofenceCheck
  kind: "CLOCK_IN" | "CLOCK_OUT" | BreakKind
  projectName: string | null
  /// When true, the panel was opened because the server rejected the
  /// clock-in for the IP whitelist (not the client-side geofence). The
  /// panel shows a network-specific heading and the `fence` prop is
  /// synthetic. Only used on clock-in.
  offNetwork?: boolean
}

type Props = {
  state: "IN" | "OUT"
  projects: AttendanceProjectView[]
  activeProject: string | null
  activeLocation: string | null
  /// Labelled fence locations for the currently-active project.
  /// Empty array means the project has no labelled locations yet —
  /// falls back to the scalar `activeProjectLat/Lng` below.
  activeProjectGeoLocations: ProjectGeoLocation[]
  activeProjectLat: number | null
  activeProjectLng: number | null
  geofenceRadiusMeters: number
  now: string
  onBreak: boolean
  /** ISO timestamp of the currently-open break, if any (for the "On break since…" label). */
  currentBreakStartedAt: string | null
  /** When true (Hourly Workers), the clock-in flow gates on a selfie capture. */
  requiresSelfieOnClockIn: boolean
  /** When true, the clock-out flow gates on a selfie capture. */
  requiresSelfieOnClockOut: boolean
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
  /** OT daily threshold in minutes — passed to the clock-out dialog to decide
   *  whether a shift remark is required. Defaults to 480 (8 h) when absent. */
  otDailyThresholdMinutes: number
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
  /** Open session from a previous day — employee forgot to clock out. When
   *  set, the card shows the timer still running, hides Break, and requires
   *  a reason before the clock-out can be submitted. */
  orphanedSession?: { sessionId: string; startedAt: string; date: string } | null
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
  activeProjectGeoLocations,
  activeProjectLat,
  activeProjectLng,
  geofenceRadiusMeters,
  now,
  onBreak,
  currentBreakStartedAt,
  requiresSelfieOnClockIn,
  requiresSelfieOnClockOut,
  enforceGeofence,
  captureLocationEnabled,
  captureLocationOnClockIn,
  captureLocationOnClockOut,
  captureLocationOnBreakStart,
  captureLocationOnBreakEnd,
  otDailyThresholdMinutes,
  todayRecord,
  latestRejection,
  pendingApproval,
  orphanedSession,
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
  const router = useRouter()
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
    console.log("[prepareClockOut] requiresSelfie=", requiresSelfieOnClockOut, "hasSelfie=", !!formData.get("selfie"), "orphanedId=", formData.get("orphanedSessionId"))
    if (requiresSelfieOnClockOut && !formData.get("selfie")) {
      setClockOutSelfiePending(formData)
      console.log("[prepareClockOut] set clockOutSelfiePending, waiting for selfie")
      return
    }
    setClockOutCommitError(null)
    // Orphaned sessions are from a previous day — there is no todayRecord,
    // so the ClockOutSummaryDialog (which uses todayRecord as its open signal)
    // would never open. Bypass the draft step and submit directly.
    if (formData.get("orphanedSessionId")) {
      startClockOutTransition(async () => {
        console.log("[orphaned clockOut] calling action, sessionId=", formData.get("orphanedSessionId"))
        try {
          const result = await clockOutAction(formData)
          console.log("[orphaned clockOut] result=", result)
          if (result.error) setClockOutCommitError(result.error)
          else router.refresh()
        } catch (e) {
          console.error("[orphaned clockOut] exception=", e)
          setClockOutCommitError("Unexpected error — see console")
        }
      })
      return
    }
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
  const [orphanedReason, setOrphanedReason] = useState("")
  const [orphanedReasonError, setOrphanedReasonError] = useState<string | null>(null)
  /// Snapshot of the most recent clock-in submission (formData + display
  /// context). Kept so we can re-open the remark panel when the server
  /// rejects for the IP whitelist — a check the client can't run
  /// preemptively, so the only signal is the returned error string.
  const lastClockInAttemptRef = useRef<{
    formData: FormData
    projectName: string | null
  } | null>(null)
  /// Remembers the last off-network error we already turned into a
  /// pendingAction, so a re-render with the same `result.error` doesn't
  /// keep re-opening the panel after the user dismisses it.
  const consumedOffNetworkErrorRef = useRef<string | null>(null)
  // Guards against a second tap firing handleClockIn/Out/Break while the
  // first is still awaiting GPS — without this, the second resolution
  // wipes any remark the user has typed and reopens the dismissed popup.
  const [isResolving, setIsResolving] = useState(false)
  /// Overlay for the clock-in path: shown while we're actually awaiting
  /// a GPS fix + running the multi-geofence walk. Reassures the user
  /// that something is happening on the (usually sub-second) wait; the
  /// existing off-site remark / IP-whitelist paths take over from here.
  const [detectingLocation, setDetectingLocation] = useState(false)
  const [employeeCoords, setEmployeeCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [gpsState, setGpsState] = useState<"idle" | "locating" | "ok" | "denied">("idle")
  /// FormData held in flight while the clock-in selfie modal is open.
  const [selfiePending, setSelfiePending] = useState<FormData | null>(null)
  /// FormData held while the clock-out selfie modal is open.
  const [clockOutSelfiePending, setClockOutSelfiePending] = useState<FormData | null>(null)
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
    if (!captureAny) {
      setGpsState("ok")
      return
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGpsState("denied")
      return
    }
    setGpsState("locating")
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

  // Server-side IP-whitelist rejection → open the remark panel so the
  // employee can type a reason (site visit / WFH) and retry. The
  // server throws `OFF_NETWORK_REMARK_REQUIRED` when the project has
  // an allowedIps list and the caller's IP doesn't match; the client
  // can't run that check preemptively, so this useEffect is the only
  // hook that surfaces the panel for this path.
  useEffect(() => {
    const err = result.error
    if (!err) {
      // Cleared error → let the next error re-fire the effect.
      consumedOffNetworkErrorRef.current = null
      return
    }
    if (
      err === consumedOffNetworkErrorRef.current ||
      !isOffNetworkError(err) ||
      pendingAction ||
      !lastClockInAttemptRef.current
    ) {
      return
    }
    consumedOffNetworkErrorRef.current = err
    const { formData, projectName } = lastClockInAttemptRef.current
    setRemark("")
    setRemarkError(null)
    setPendingAction({
      formData,
      // Synthetic fence — the panel only reads `reason` for the
      // heading fallback. `offNetwork: true` below routes to a
      // network-specific heading instead.
      fence: { withinRadius: false, distanceMeters: null, reason: "no_gps" },
      kind: "CLOCK_IN",
      projectName,
      offNetwork: true,
    })
  }, [result.error, pendingAction])

  // Resolve the fence for the currently-relevant project — the
  // picker's `selected` while OUT, the active session's project
  // while IN. Includes labelled multi-locations if the project has
  // any; falls back to the legacy scalar for un-backfilled rows.
  const targetProjectFence: {
    latitude: number | null
    longitude: number | null
    geoLocations: ProjectGeoLocation[]
  } =
    state === "OUT"
      ? (() => {
          const p = projects.find((proj) => proj.id === selected)
          return p
            ? {
                latitude: p.latitude,
                longitude: p.longitude,
                geoLocations: p.geoLocations,
              }
            : { latitude: null, longitude: null, geoLocations: [] }
        })()
      : {
          latitude: activeProjectLat,
          longitude: activeProjectLng,
          geoLocations: activeProjectGeoLocations,
        }
  // Client-side pre-check that mirrors the server's multi-fence
  // math (`checkGeofenceMulti` on the service side). Without this
  // helper an employee at "Site B" would trigger the client's
  // off-site prompt against the legacy scalar (which usually only
  // holds Site A's coords) even though the server would then accept
  // them. Falls back to the single-scalar `checkGeofence` for
  // projects that haven't been backfilled into `geoLocations` yet.
  function checkProjectFence(
    coords: { lat: number; lng: number } | null,
    project: {
      latitude: number | null
      longitude: number | null
      geoLocations: ProjectGeoLocation[]
    },
    radiusMeters: number,
  ): GeofenceCheck {
    if (project.geoLocations.length > 0) {
      const multi = checkGeofenceMulti(
        coords ? { latitude: coords.lat, longitude: coords.lng } : null,
        project.geoLocations,
        radiusMeters,
      )
      if (multi.ok) {
        return {
          withinRadius: true,
          distanceMeters: multi.distanceMeters,
          reason: "ok",
        }
      }
      return {
        withinRadius: false,
        distanceMeters: multi.nearest?.distanceMeters ?? null,
        reason: coords ? "outside_radius" : "no_gps",
      }
    }
    return checkGeofence(
      coords,
      { latitude: project.latitude, longitude: project.longitude },
      radiusMeters,
    )
  }
  const liveFence: GeofenceCheck = enforceGeofence
    ? checkProjectFence(employeeCoords, targetProjectFence, geofenceRadiusMeters)
    : { withinRadius: true, distanceMeters: null, reason: "ok" }

  function dispatch(action: PendingAction) {
    if (action.kind === "CLOCK_IN") {
      startTransition(() => formAction(action.formData))
    } else if (action.kind === "CLOCK_OUT") {
      prepareClockOut(action.formData)
    } else if (action.kind === "BREAK_START") {
      startBreakTransition(async () => {
        await startBreakAction(action.formData)
        router.refresh()
      })
    } else {
      startBreakTransition(async () => {
        await endBreakAction(action.formData)
        router.refresh()
      })
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
        setDetectingLocation(true)
        await resolveCoordsForSubmit(formData, employeeCoords)
      }
      const fence: GeofenceCheck = enforceGeofence
        ? checkProjectFence(
            readCoordsFrom(formData),
            project ?? { latitude: null, longitude: null, geoLocations: [] },
            geofenceRadiusMeters,
          )
        : { withinRadius: true, distanceMeters: null, reason: "ok" }
      if (fence.withinRadius) {
        // Snapshot the attempt so we can re-surface the remark panel
        // when the server rejects on the IP-whitelist check (which the
        // client can't run preemptively — same envelope, no notes).
        lastClockInAttemptRef.current = {
          formData,
          projectName: project?.name ?? null,
        }
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
      setDetectingLocation(false)
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

  function onClockOutSelfieConfirmed(dataUrl: string) {
    console.log("[selfieConfirmed] pending=", !!clockOutSelfiePending)
    if (!clockOutSelfiePending) return
    clockOutSelfiePending.set("selfie", dataUrl)
    const fd = clockOutSelfiePending
    console.log("[selfieConfirmed] orphanedSessionId=", fd.get("orphanedSessionId"))
    setClockOutSelfiePending(null)
    setClockOutCommitError(null)
    // Same bypass as prepareClockOut: orphaned sessions have no todayRecord,
    // so the summary dialog never opens — submit directly instead.
    if (fd.get("orphanedSessionId")) {
      startClockOutTransition(async () => {
        console.log("[selfieConfirmed transition] calling clockOutAction")
        try {
          const result = await clockOutAction(fd)
          console.log("[selfieConfirmed transition] result=", result)
          if (result.error) setClockOutCommitError(result.error)
          else router.refresh()
        } catch (e) {
          console.error("[selfieConfirmed transition] exception=", e)
          setClockOutCommitError("Unexpected error — see console")
        }
      })
      return
    }
    setClockOutDraft({ formData: fd })
  }

  function onClockOutSelfieCancelled() {
    setClockOutSelfiePending(null)
  }

  async function handleClockOut(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (isResolving || pendingAction) return
    // When closing an orphaned (previous-day) session, require the reason field.
    if (orphanedSession) {
      const trimmedReason = orphanedReason.trim()
      if (!trimmedReason) {
        setOrphanedReasonError("Please explain why you didn't clock out.")
        return
      }
      setOrphanedReasonError(null)
    }
    setIsResolving(true)
    try {
      const formData = new FormData(e.currentTarget)
      // Inject orphaned-session fields before geofence / coord resolution.
      if (orphanedSession) {
        formData.set("notes", orphanedReason.trim())
        formData.set("orphanedSessionId", orphanedSession.sessionId)
      }
      const captureForThisEvent =
        enforceGeofence || (captureLocationEnabled && captureLocationOnClockOut)
      if (captureForThisEvent) {
        await resolveCoordsForSubmit(formData, employeeCoords)
      }
      const fence: GeofenceCheck = enforceGeofence
        ? checkProjectFence(
            readCoordsFrom(formData),
            {
              latitude: activeProjectLat,
              longitude: activeProjectLng,
              geoLocations: activeProjectGeoLocations,
            },
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
        ? checkProjectFence(
            readCoordsFrom(formData),
            {
              latitude: activeProjectLat,
              longitude: activeProjectLng,
              geoLocations: activeProjectGeoLocations,
            },
            geofenceRadiusMeters,
          )
        : { withinRadius: true, distanceMeters: null, reason: "ok" }
      if (fence.withinRadius) {
        startBreakTransition(async () => {
          if (kind === "BREAK_START") {
            await startBreakAction(formData)
          } else {
            await endBreakAction(formData)
          }
          router.refresh()
        })
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
      setRemarkError(
        pendingAction.offNetwork
          ? "A remark is required when you're off-network."
          : "A remark is required when you're off-site.",
      )
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
      <div className="mb-4">
        <div className="flex items-start justify-between gap-4">
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
            </div>
          ) : null}
        </div>

        {/* Location + geofence status as a single full-width strip
            below the header, so the off-site distance text has room to
            sit on one line instead of wrapping inside a cramped
            right-aligned column. The raw You/Site coord dump that used
            to live here (dev debug) is gone. */}
        {state === "IN" && activeProject && (activeLocation || enforceGeofence) ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-2xl bg-surface-low px-3.5 py-2.5">
            {activeLocation ? (
              <a
                href={`https://www.google.com/maps?q=${encodeURIComponent(activeLocation)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary underline-offset-2 hover:underline"
              >
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                Open in maps
              </a>
            ) : (
              <span />
            )}
            {enforceGeofence ? (
              <DistanceIndicator
                gpsState={gpsState}
                fence={liveFence}
                radius={geofenceRadiusMeters}
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
                is pending supervisor review. You can still continue
                clocking in or out — your supervisor will approve later.
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
            />
          </form>
        </div>
      ) : (
        <div className="space-y-3">
          {orphanedSession ? (
            <div className="rounded-[20px] border border-amber-300/60 bg-amber-50 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-amber-900">
                    Session from {orphanedSession.date} — still running
                  </p>
                  <p className="mt-0.5 text-xs text-amber-800">
                    <ElapsedTimer startedAt={orphanedSession.startedAt} />
                  </p>
                </div>
              </div>
            </div>
          ) : null}
          {orphanedSession ? (
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Why didn&apos;t you clock out? (required)
              </label>
              <textarea
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                rows={2}
                placeholder="e.g. Forgot to clock out before leaving"
                value={orphanedReason}
                onChange={(e) => {
                  setOrphanedReason(e.target.value)
                  if (e.target.value.trim()) setOrphanedReasonError(null)
                }}
              />
              {orphanedReasonError ? (
                <p className="mt-1 text-[11px] font-semibold text-destructive">
                  {orphanedReasonError}
                </p>
              ) : null}
            </div>
          ) : null}
          {orphanedSession && clockOutCommitError ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] font-semibold text-destructive">
              {clockOutCommitError}
            </p>
          ) : null}
          <div className={orphanedSession ? "" : "grid grid-cols-2 gap-3"}>
            {!orphanedSession ? (
              <form onSubmit={(e) => handleBreak(e, "BREAK_START")}>
                <BreakStartButton
                  pending={isBreakPending || isResolving}
                />
              </form>
            ) : null}
            <form onSubmit={handleClockOut}>
              <ClockOutButton
                pending={isClockOutPending || isResolving}
              />
            </form>
          </div>
        </div>
      )}

      {pendingAction ? (
        <RemarkPanel
          fence={pendingAction.fence}
          projectName={pendingAction.projectName}
          offNetwork={pendingAction.offNetwork === true}
          remark={remark}
          onChange={setRemark}
          onConfirm={confirmRemark}
          onCancel={cancelRemark}
          error={remarkError}
        />
      ) : null}

    </Card>
    {/* These overlays must live OUTSIDE <Card>: the card has `backdrop-blur-sm`
        (backdrop-filter), which makes it the containing block for position:fixed
        descendants — so a `fixed inset-0` modal rendered inside the card collapses
        to the card's bounds instead of covering the screen. Kept here as siblings
        (like ClockOutSummaryDialog) so they overlay the full viewport. */}
    {selfiePending ? (
      <SelfieCaptureModal
        onConfirm={onSelfieConfirmed}
        onCancel={onSelfieCancelled}
      />
    ) : null}

    {clockOutSelfiePending ? (
      <SelfieCaptureModal
        onConfirm={onClockOutSelfieConfirmed}
        onCancel={onClockOutSelfieCancelled}
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

    {detectingLocation ? <DetectingLocationModal /> : null}
    <ClockOutSummaryDialog
      todayRecord={clockOutDraft ? todayRecord : null}
      pending={isClockOutPending}
      error={clockOutCommitError}
      onConfirm={commitClockOut}
      onClose={cancelClockOutDraft}
      otThresholdMin={otDailyThresholdMinutes}
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
  offNetwork,
  remark,
  onChange,
  onConfirm,
  onCancel,
  error,
}: {
  fence: GeofenceCheck
  projectName: string | null
  offNetwork: boolean
  remark: string
  onChange: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
  error: string | null
}) {
  const heading = offNetwork
    ? "You're not on the office network"
    : fence.reason === "no_gps"
      ? "Location unavailable — add a remark"
      : fence.reason === "no_project_coords"
        ? "Project has no coordinates set — add a remark"
        : `You're ${fence.distanceMeters != null ? formatDistance(fence.distanceMeters) : "?m"} from ${projectName ?? "the project"}`
  const body = offNetwork
    ? "Add a remark explaining why you're off-network (site visit / WFH). Your approver will see it."
    : "Add a remark explaining why you're off-site. Your approver will see it."
  const placeholder = offNetwork
    ? "e.g. WFH today, on-site at client premises"
    : "e.g. Stuck in traffic, on-site at client office"

  return (
    <div className="mt-4 rounded-[20px] border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-bold text-amber-900">{heading}</p>
      <p className="mt-1 text-xs text-amber-800">{body}</p>
      <textarea
        value={remark}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
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
}: {
  gpsState: "idle" | "locating" | "ok" | "denied"
  fence: GeofenceCheck
  radius: number
}) {
  if (gpsState === "locating" || gpsState === "idle") {
    return (
      <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Locating you…
      </p>
    )
  }
  if (gpsState === "denied" || fence.reason === "no_gps") {
    return (
      <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-700">
        <AlertTriangle className="h-3 w-3" />
        Location unavailable
      </p>
    )
  }
  if (fence.reason === "no_project_coords") {
    return (
      <p className="text-[11px] font-semibold text-muted-foreground">
        No geofence set
      </p>
    )
  }
  const display = formatDistance(fence.distanceMeters ?? 0)
  return fence.withinRadius ? (
    <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-success">
      <span className="h-1.5 w-1.5 rounded-full bg-success" />
      On site · {display} away
    </p>
  ) : (
    <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-700">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      Off site · {display} away (limit {radius}m)
    </p>
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

/// Non-cancellable status modal shown while the client is waiting for a
/// GPS fix + running the multi-geofence walk during clock-in. The wait
/// is typically sub-second; a browser-level PositionError timeout still
/// aborts the flow via the existing GPS error path if the OS hangs.
function DetectingLocationModal() {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div
        role="status"
        aria-live="polite"
        className="w-full max-w-xs rounded-3xl border border-border/60 bg-card p-6 text-center shadow-xl"
      >
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
        <p className="text-sm font-bold text-foreground">
          Detecting your location…
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Checking against this project&apos;s geofence.
        </p>
      </div>
    </div>
  )
}

export type ClockCardProps = Props
