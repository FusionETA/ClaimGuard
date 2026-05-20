"use client"

import { useMemo, useState, useTransition } from "react"

import { cancelLeaveAction, submitLeaveAction } from "@/app/(employee)/employee/leave/actions"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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

type BalanceRow = {
  id: string
  leaveTypeId: string
  leaveTypeCode: string
  leaveTypeName: string
  paid: boolean
  accrualMethod: "LUMP_SUM" | "PRO_RATED"
  entitledDays: number
  carriedDays: number
  carriedExpiresAt: string | null
  carriedExpired: boolean
  accruedDays: number
  usedDays: number
  availableDays: number
}

type ApplicationRow = {
  id: string
  leaveTypeCode: string
  leaveTypeName: string
  paid: boolean
  startDate: string
  endDate: string
  duration: "FULL_DAY" | "MORNING" | "AFTERNOON"
  totalDays: number
  reason: string | null
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"
  currentStep: number
  createdAt: string
  decidedAt: string | null
}

// Stable date format used on both server and client to avoid hydration
// mismatch — `toLocaleDateString()` would format differently in Node vs.
// the browser depending on system locale.
function fmtDate(iso: string): string {
  return iso.slice(0, 10) // YYYY-MM-DD
}

type Tab = "apply" | "balances"

export function EmployeeLeaveView(props: {
  year: number
  balances: BalanceRow[]
  applications: ApplicationRow[]
}) {
  const [tab, setTab] = useState<Tab>("apply")
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Leave</h1>
        <p className="text-sm text-muted-foreground">
          Apply for leave or check your balances for {props.year}.
        </p>
      </div>

      <div className="flex gap-2 border-b">
        <TabButton active={tab === "apply"} onClick={() => setTab("apply")}>
          Apply &amp; history
        </TabButton>
        <TabButton active={tab === "balances"} onClick={() => setTab("balances")}>
          Balances
        </TabButton>
      </div>

      {tab === "apply" && (
        <>
          <ApplyCard balances={props.balances} />
          <ApplicationsCard applications={props.applications} />
        </>
      )}
      {tab === "balances" && <BalancesCard balances={props.balances} />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-4 py-2 text-sm font-medium border-b-2 transition-colors " +
        (active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </button>
  )
}

function BalancesCard({ balances }: { balances: BalanceRow[] }) {
  if (balances.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Balances</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No leave types configured for your organization yet.
          </p>
        </CardContent>
      </Card>
    )
  }
  return (
    <Card>
      <CardHeader><CardTitle>Balances</CardTitle></CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {balances.map((b) => (
            <div key={b.id} className="rounded-2xl border p-4">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-sm font-medium">{b.leaveTypeName}</div>
                  <div className="text-xs text-muted-foreground font-mono">{b.leaveTypeCode}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-semibold">{b.availableDays}</div>
                  <div className="text-xs text-muted-foreground">days available</div>
                </div>
              </div>
              {b.paid ? (
                <div className="mt-3 text-xs text-muted-foreground space-y-0.5">
                  <div>
                    Entitled: {b.entitledDays}
                    {b.accrualMethod === "PRO_RATED" && (
                      <> · Accrued: {b.accruedDays.toFixed(2)}</>
                    )}
                  </div>
                  <div>Used: {b.usedDays}</div>
                  {b.carriedDays > 0 && (
                    <div>
                      Carried: {b.carriedDays}
                      {b.carriedExpiresAt && !b.carriedExpired && (
                        <> · expires {fmtDate(b.carriedExpiresAt)}</>
                      )}
                      {b.carriedExpired && <> (expired)</>}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-3 text-xs text-muted-foreground">Unpaid leave</div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function ApplyCard({ balances }: { balances: BalanceRow[] }) {
  const [leaveTypeId, setLeaveTypeId] = useState<string>(balances[0]?.leaveTypeId ?? "")
  const [startDate, setStartDate] = useState<string>("")
  const [endDate, setEndDate] = useState<string>("")
  const [duration, setDuration] = useState<"FULL_DAY" | "MORNING" | "AFTERNOON">("FULL_DAY")
  const [reason, setReason] = useState("")
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  const selected = useMemo(
    () => balances.find((b) => b.leaveTypeId === leaveTypeId),
    [balances, leaveTypeId],
  )

  const sameDay = startDate !== "" && startDate === endDate
  const effectiveDuration: "FULL_DAY" | "MORNING" | "AFTERNOON" =
    sameDay ? duration : "FULL_DAY"

  function submit() {
    setMessage(null)
    const fd = new FormData()
    fd.set("leaveTypeId", leaveTypeId)
    fd.set("startDate", startDate)
    fd.set("endDate", endDate)
    fd.set("duration", effectiveDuration)
    fd.set("reason", reason)
    startTransition(async () => {
      const res = await submitLeaveAction(fd)
      if (!res.ok) {
        setMessage({ kind: "err", text: res.error })
        return
      }
      setMessage({
        kind: "ok",
        text: `Submitted (${res.totalDays} day${res.totalDays === 1 ? "" : "s"}). Status: ${res.status}.`,
      })
      setReason("")
    })
  }

  return (
    <Card>
      <CardHeader><CardTitle>Apply for leave</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>Leave type</Label>
          <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
            <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>
              {balances.map((b) => (
                <SelectItem key={b.leaveTypeId} value={b.leaveTypeId}>
                  {b.leaveTypeName} · {b.paid ? `${b.availableDays} day(s) available` : "unpaid"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && selected.paid && (
            <p className="text-xs text-muted-foreground mt-1">
              Available balance: {selected.availableDays} day{selected.availableDays === 1 ? "" : "s"}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="startDate">Start date</Label>
            <Input
              id="startDate"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="endDate">End date</Label>
            <Input
              id="endDate"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <div>
          <Label>Duration</Label>
          <Select
            value={effectiveDuration}
            onValueChange={(v) => setDuration(v as "FULL_DAY" | "MORNING" | "AFTERNOON")}
            disabled={!sameDay}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="FULL_DAY">Full day</SelectItem>
              <SelectItem value="MORNING">Morning (0.5)</SelectItem>
              <SelectItem value="AFTERNOON">Afternoon (0.5)</SelectItem>
            </SelectContent>
          </Select>
          {!sameDay && (
            <p className="text-xs text-muted-foreground mt-1">
              Half-day options are only available when start and end are the same day.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="reason">Reason (optional)</Label>
          <Textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Brief reason for your supervisor"
          />
        </div>

        {message && (
          <p className={message.kind === "ok" ? "text-sm text-emerald-600" : "text-sm text-destructive"}>
            {message.text}
          </p>
        )}

        <div className="flex justify-end">
          <Button onClick={submit} disabled={pending || !leaveTypeId || !startDate || !endDate}>
            {pending ? "Submitting…" : "Submit"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function ApplicationsCard({ applications }: { applications: ApplicationRow[] }) {
  const [pending, startTransition] = useTransition()
  return (
    <Card>
      <CardHeader><CardTitle>My applications</CardTitle></CardHeader>
      <CardContent>
        {applications.length === 0 ? (
          <p className="text-sm text-muted-foreground">No applications yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">Type</th>
                  <th>Dates</th>
                  <th>Days</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {applications.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2">{a.leaveTypeName}</td>
                    <td>
                      {fmtDate(a.startDate)}
                      {a.startDate !== a.endDate && (
                        <> → {fmtDate(a.endDate)}</>
                      )}
                      {a.duration !== "FULL_DAY" && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({a.duration === "MORNING" ? "AM" : "PM"})
                        </span>
                      )}
                    </td>
                    <td>{a.totalDays}</td>
                    <td>
                      <span
                        className={
                          a.status === "APPROVED"
                            ? "text-emerald-600"
                            : a.status === "REJECTED"
                              ? "text-destructive"
                              : a.status === "CANCELLED"
                                ? "text-muted-foreground"
                                : ""
                        }
                      >
                        {a.status}
                      </span>
                    </td>
                    <td>{fmtDate(a.createdAt)}</td>
                    <td className="text-right">
                      {(a.status === "PENDING" || a.status === "APPROVED") && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => startTransition(async () => {
                            await cancelLeaveAction(a.id)
                          })}
                        >
                          Cancel
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
