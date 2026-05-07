"use client"

import { useActionState, useEffect, useRef, useState, useTransition } from "react"
import { createPortal } from "react-dom"
import { Camera, Coffee, Fingerprint, LogOut, RotateCcw, X } from "lucide-react"

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
} from "@/modules/attendance/domain/models"
import { checkGeofence, type GeofenceCheck } from "@/lib/geo"

import {
  clockInAction,
  clockOutAction,
  endBreakAction,
  startBreakAction,
  type ClockInState,
} from "./actions"

async function attachCoords(formData: FormData): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return
  try {
    const position = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        timeout: 8000,
        maximumAge: 0,
      })
    })
    formData.set("lat", String(position.coords.latitude))
    formData.set("lng", String(position.coords.longitude))
  } catch {
    // GPS denied/unavailable/timed out — proceed without coords
  }
}

function readCoordsFrom(formData: FormData): { lat: number; lng: number } | null {
  const lat = parseFloat(String(formData.get("lat") ?? ""))
  const lng = parseFloat(String(formData.get("lng") ?? ""))
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
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

function ClockOutButton({ pending }: { pending: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex w-full flex-col items-center justify-center rounded-[28px] border border-border/70 bg-card/94 py-5 shadow-ambient backdrop-blur-sm transition hover:bg-card active:scale-95 disabled:opacity-50"
    >
      <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-destructive text-destructive-foreground">
        <LogOut className="h-6 w-6" />
      </div>
      <p className="text-sm font-bold text-destructive">
        {pending ? "Clocking out…" : "Clock Out"}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">End shift</p>
    </button>
  )
}

function BreakStartButton({ pending }: { pending: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex w-full flex-col items-center justify-center rounded-[28px] border border-border/70 bg-card/94 py-5 shadow-ambient backdrop-blur-sm transition hover:bg-card active:scale-95 disabled:opacity-50"
    >
      <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
        <Coffee className="h-6 w-6" />
      </div>
      <p className="text-sm font-bold text-foreground">
        {pending ? "Saving…" : "Start Break"}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        Pauses your shift
      </p>
    </button>
  )
}

function BreakEndButton({ pending }: { pending: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex w-full flex-col items-center justify-center rounded-[28px] border border-amber-300 bg-amber-50 py-5 shadow-ambient backdrop-blur-sm transition hover:bg-amber-100 active:scale-95 disabled:opacity-50"
    >
      <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500 text-white">
        <Coffee className="h-6 w-6" />
      </div>
      <p className="text-sm font-bold text-amber-900">
        {pending ? "Saving…" : "End Break"}
      </p>
      <p className="mt-0.5 text-[11px] text-amber-800">
        Resumes your shift
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
}: Props) {
  const [selected, setSelected] = useState("")
  const [result, formAction] = useActionState<ClockInState, FormData>(
    clockInAction,
    {},
  )
  const [isPending, startTransition] = useTransition()
  const [isClockOutPending, startClockOutTransition] = useTransition()
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

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGpsState("denied")
      return
    }
    setGpsState("locating")
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setEmployeeCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setGpsState("ok")
      },
      () => setGpsState("denied"),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 30000 },
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  const targetProjectCoords: { latitude: number | null; longitude: number | null } | null =
    state === "OUT"
      ? (() => {
          const p = projects.find((proj) => proj.id === selected)
          return p ? { latitude: p.latitude, longitude: p.longitude } : null
        })()
      : { latitude: activeProjectLat, longitude: activeProjectLng }
  const liveFence = checkGeofence(
    employeeCoords,
    targetProjectCoords ?? { latitude: null, longitude: null },
    geofenceRadiusMeters,
  )

  function dispatch(action: PendingAction) {
    if (action.kind === "CLOCK_IN") {
      startTransition(() => formAction(action.formData))
    } else if (action.kind === "CLOCK_OUT") {
      startClockOutTransition(() => clockOutAction(action.formData))
    } else if (action.kind === "BREAK_START") {
      startBreakTransition(() => startBreakAction(action.formData))
    } else {
      startBreakTransition(() => endBreakAction(action.formData))
    }
  }

  async function handleClockIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (isResolving || pendingAction || selfiePending) return
    const formData = new FormData(e.currentTarget)
    if (requiresSelfieOnClockIn && !formData.get("selfie")) {
      // Pause here, ask the employee to take a selfie. The rest of the
      // flow (GPS, geofence, remark, dispatch) resumes from
      // proceedClockIn() once the photo is confirmed.
      setSelfiePending(formData)
      return
    }
    await proceedClockIn(formData)
  }

  async function proceedClockIn(formData: FormData) {
    setIsResolving(true)
    try {
      const project = projects.find((p) => p.id === selected) ?? null
      await attachCoords(formData)
      fallbackCoordsFromState(formData, employeeCoords)
      const fence = checkGeofence(
        readCoordsFrom(formData),
        project ?? { latitude: null, longitude: null },
        geofenceRadiusMeters,
      )
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
      await attachCoords(formData)
      fallbackCoordsFromState(formData, employeeCoords)
      const fence = checkGeofence(
        readCoordsFrom(formData),
        { latitude: activeProjectLat, longitude: activeProjectLng },
        geofenceRadiusMeters,
      )
      if (fence.withinRadius) {
        startClockOutTransition(() => clockOutAction(formData))
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
      await attachCoords(formData)
      fallbackCoordsFromState(formData, employeeCoords)
      const fence = checkGeofence(
        readCoordsFrom(formData),
        { latitude: activeProjectLat, longitude: activeProjectLng },
        geofenceRadiusMeters,
      )
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
                onValueChange={setSelected}
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
            {selected ? (
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
            <BreakEndButton pending={isBreakPending || isResolving} />
          </form>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <form onSubmit={(e) => handleBreak(e, "BREAK_START")}>
            <BreakStartButton pending={isBreakPending || isResolving} />
          </form>
          <form onSubmit={handleClockOut}>
            <ClockOutButton pending={isClockOutPending || isResolving} />
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
    </Card>
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
        className="mt-2 block w-full rounded-[14px] border border-amber-300 bg-white px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
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

export type ClockCardProps = Props
