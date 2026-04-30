"use client"

import { useActionState, useState, useTransition } from "react"
import { Coffee, Fingerprint, LogOut } from "lucide-react"

import { Card } from "@/components/attendance/ui/card"
import type {
  AttendanceProjectView,
  ClockEventLite,
} from "@/modules/attendance/domain/models"
import { cn } from "@/lib/utils"

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

type Props = {
  state: "IN" | "OUT"
  projects: AttendanceProjectView[]
  activeProject: string | null
  activeLocation: string | null
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

export function ClockCard({ state, projects, activeProject, activeLocation, now }: Props) {
  const [selected, setSelected] = useState("")
  const [result, formAction] = useActionState<ClockInState, FormData>(
    clockInAction,
    {},
  )
  const [isPending, startTransition] = useTransition()
  const [isClockOutPending, startClockOutTransition] = useTransition()
  const [isBreakPending, startBreakTransition] = useTransition()

  async function handleClockIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    await attachCoords(formData)
    startTransition(() => {
      formAction(formData)
    })
  }

  async function handleClockOut(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    await attachCoords(formData)
    startClockOutTransition(() => {
      clockOutAction(formData)
    })
  }

  async function handleBreak(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    await attachCoords(formData)
    startBreakTransition(() => {
      confirmBreakAction(formData)
    })
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
                Ask your admin to sync projects from Xero.
              </p>
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
    </Card>
  )
}

export type ClockCardProps = Props
