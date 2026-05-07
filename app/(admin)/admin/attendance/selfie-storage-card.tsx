"use client"

import { useActionState, useState } from "react"
import { Camera, Loader2, Trash2 } from "lucide-react"

import { Button } from "@/components/attendance/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/attendance/ui/input"
import { Label } from "@/components/attendance/ui/label"

import {
  deleteSelfiesInRangeAction,
  type DeleteSelfiesResult,
  type SelfieStorageStats,
} from "./actions"

type Props = {
  initialStats: SelfieStorageStats
  defaultFrom: string
  defaultTo: string
}

const initialResult: DeleteSelfiesResult = {}

function fmtDate(iso: string | null): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export function SelfieStorageCard({
  initialStats,
  defaultFrom,
  defaultTo,
}: Props) {
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(defaultTo)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [result, formAction, pending] = useActionState(
    deleteSelfiesInRangeAction,
    initialResult,
  )

  function applyPreset(days: number | "all") {
    const today = new Date()
    const todayIso = today.toISOString().slice(0, 10)
    if (days === "all") {
      setFrom("2000-01-01")
      setTo(todayIso)
      return
    }
    const cutoff = new Date(today.getTime() - days * 24 * 60 * 60 * 1000)
    setFrom("2000-01-01")
    setTo(cutoff.toISOString().slice(0, 10))
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
        <div className="flex items-center gap-2">
          <Camera className="h-4 w-4 text-muted-foreground" />
          <CardTitle>Selfie storage</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Stored
            </p>
            <p className="mt-1 text-2xl font-bold text-foreground">
              {initialStats.total}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Oldest
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {fmtDate(initialStats.oldest)}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Newest
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {fmtDate(initialStats.newest)}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border/60 p-3">
          <p className="text-xs font-semibold text-foreground">
            Delete a date range
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Removes the photo from Xero and clears the link on each
            AttendanceRecord. Hourly Worker selfies only — Office Workers
            never have one.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <Label
                htmlFor="selfie-from"
                className="text-[10px] uppercase tracking-wider"
              >
                From
              </Label>
              <Input
                id="selfie-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 w-[150px]"
                disabled={pending}
              />
            </div>
            <div>
              <Label
                htmlFor="selfie-to"
                className="text-[10px] uppercase tracking-wider"
              >
                To
              </Label>
              <Input
                id="selfie-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 w-[150px]"
                disabled={pending}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <PresetButton
                label="> 7 days old"
                onClick={() => applyPreset(7)}
                disabled={pending}
              />
              <PresetButton
                label="> 30 days old"
                onClick={() => applyPreset(30)}
                disabled={pending}
              />
              <PresetButton
                label="All time"
                onClick={() => applyPreset("all")}
                disabled={pending}
              />
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="text-xs">
              {result.error ? (
                <span className="font-semibold text-destructive">
                  {result.error}
                </span>
              ) : result.ok ? (
                <span className="font-semibold text-success">
                  Scanned {result.scanned} · Deleted {result.deleted}
                  {(result.failed ?? 0) > 0
                    ? ` · ${result.failed} failed`
                    : ""}
                </span>
              ) : null}
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={pending}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete in range
            </Button>
          </div>
        </div>

        {confirmOpen ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-bold text-foreground">
              Delete all selfies uploaded between {fmtDate(`${from}T00:00`)}{" "}
              and {fmtDate(`${to}T00:00`)}?
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              This permanently removes them from Xero. Cannot be undone.
            </p>
            <form
              action={(fd) => {
                fd.set("from", from)
                fd.set("to", to)
                setConfirmOpen(false)
                return formAction(fd)
              }}
              className="mt-3 flex justify-end gap-2"
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={pending}
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Deleting…
                  </>
                ) : (
                  "Confirm delete"
                )}
              </Button>
            </form>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function PresetButton({
  label,
  onClick,
  disabled,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-border/60 bg-card px-2.5 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-muted disabled:opacity-50"
    >
      {label}
    </button>
  )
}
