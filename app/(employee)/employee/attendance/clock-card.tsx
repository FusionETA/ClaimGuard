"use client"

import { useActionState, useEffect, useState, useTransition } from "react"
import { Coffee, Fingerprint, LogOut } from "lucide-react"

import { Card } from "@/components/attendance/ui/card"
import type {
  AttendanceProjectView,
} from "@/modules/attendance/domain/models"
import { cn } from "@/lib/utils"
import { checkGeofence, type GeofenceCheck } from "@/lib/geo"

import {
  clockInAction,
  clockOutAction,
  confirmBreakAction,
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

type PendingAction = {
  formData: FormData
  fence: GeofenceCheck
  kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK"
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

function BreakButton({ pending }: { pending: boolean }) {
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
        {pending ? "Saving…" : "Confirm Break"}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">Still on site</p>
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
  const [employeeCoords, setEmployeeCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [gpsState, setGpsState] = useState<"idle" | "locating" | "ok" | "denied">("idle")

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
    } else {
      startBreakTransition(() => confirmBreakAction(action.formData))
    }
  }

  async function handleClockIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
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
  }

  async function handleClockOut(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
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
  }

  async function handleBreak(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    await attachCoords(formData)
    fallbackCoordsFromState(formData, employeeCoords)
    const fence = checkGeofence(
      readCoordsFrom(formData),
      { latitude: activeProjectLat, longitude: activeProjectLng },
      geofenceRadiusMeters,
    )
    if (fence.withinRadius) {
      startBreakTransition(() => confirmBreakAction(formData))
      return
    }
    setRemark("")
    setRemarkError(null)
    setPendingAction({
      formData,
      fence,
      kind: "BREAK",
      projectName: activeProject,
    })
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
            <select
              id="projectId"
              name="projectId"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className={cn(
                "mt-1 block h-10 w-full rounded-[20px] border border-border/70 bg-card/94 px-3 text-sm font-semibold text-foreground shadow-ambient backdrop-blur-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              )}
            >
              <option value="">
                {projects.length === 0 ? "No projects available" : "Select a project…"}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
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
          <ClockInButton pending={isPending} />
          {result.error ? (
            <p className="text-xs font-semibold text-destructive">{result.error}</p>
          ) : null}
        </form>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <form onSubmit={handleBreak}>
            <BreakButton pending={isBreakPending} />
          </form>
          <form onSubmit={handleClockOut}>
            <ClockOutButton pending={isClockOutPending} />
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
    </Card>
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
        Add a remark explaining why you're off-site. Your supervisor will see it.
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
