"use client"

import { useMemo, useState, useTransition } from "react"
import { Plus } from "lucide-react"

import { formatDays } from "@/lib/utils"
import { forecastAccruedOnDate } from "@/modules/leave/domain/accrual"

import {
  cancelLeaveAction,
  editLeaveAction,
  submitLeaveAction,
} from "@/app/(employee)/employee/leave/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ConfirmActionDialog } from "@/components/ui/confirm-action-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

export type BalanceRow = {
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
  leaveTypeId: string
  leaveTypeCode: string
  leaveTypeName: string
  paid: boolean
  startDate: string
  endDate: string
  duration: "FULL_DAY" | "MORNING" | "AFTERNOON"
  totalDays: number
  reason: string | null
  attachmentUrl: string | null
  attachmentName: string | null
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"
  currentStep: number
  approvalsCount: number
  createdAt: string
  decidedAt: string | null
}

// Stable date format used on both server and client to avoid hydration
// mismatch — `toLocaleDateString()` would format differently in Node vs.
// the browser depending on system locale.
function fmtDate(iso: string): string {
  return iso.slice(0, 10) // YYYY-MM-DD
}

/// Today's date in the user's local timezone as YYYY-MM-DD — used to
/// pre-fill the apply-leave date fields so the common "applying for
/// today" case needs no extra clicks.
function todayLocalISO(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

export function EmployeeLeaveView(props: {
  year: number
  balances: BalanceRow[]
  applications: ApplicationRow[]
  /// Employee's payroll-profile join date as ISO string. Used to forecast
  /// PRO_RATED balances on the leave-apply form. Null when not set.
  joinDate: string | null
  /// Org-level toggle. When true, the leave-apply form shows the
  /// projected available balance on the picked start date (for PRO_RATED
  /// leave types) so employees know whether their forecasted request
  /// will be accepted before submitting.
  allowForecastedLeaveApply: boolean
}) {
  const [applyOpen, setApplyOpen] = useState(false)

  return (
    <>
      <div className="space-y-6">
        <ApplicationsCard
          applications={props.applications}
          balances={props.balances}
        />
        <BalancesCard balances={props.balances} />
      </div>

      <button
        type="button"
        aria-label="Apply for leave"
        onClick={() => setApplyOpen(true)}
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-panel transition-transform hover:scale-105 active:scale-95 lg:bottom-8 lg:right-8"
      >
        <Plus className="h-6 w-6" />
      </button>

      <Dialog open={applyOpen} onOpenChange={setApplyOpen}>
        <DialogContent
          className="flex max-h-[90vh] w-[min(92vw,640px)] flex-col overflow-hidden px-6 pb-6 pt-6 sm:max-w-[640px]"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>Apply for leave</DialogTitle>
            <DialogDescription>
              Pick a leave type and dates. Attach an MC slip if relevant.
            </DialogDescription>
          </DialogHeader>
          <div
            className="flex-1 overflow-y-auto px-1"
            style={{ scrollbarGutter: "stable both-edges" }}
          >
            <ApplyForm
              balances={props.balances}
              joinDate={props.joinDate}
              allowForecastedLeaveApply={props.allowForecastedLeaveApply}
              onSuccess={() => setApplyOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
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
                  <div className="text-2xl font-semibold">
                    {formatDays(b.paid ? b.availableDays : b.usedDays)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {b.paid ? "days available" : "days used"}
                  </div>
                </div>
              </div>
              {b.paid ? (
                <div className="mt-3 text-xs text-muted-foreground space-y-0.5">
                  <div>
                    Entitled: {formatDays(b.entitledDays)}
                    {b.accrualMethod === "PRO_RATED" && (
                      <> · Accrued: {formatDays(b.accruedDays)}</>
                    )}
                  </div>
                  <div>Used: {formatDays(b.usedDays)}</div>
                  {b.carriedDays > 0 && (
                    <div>
                      Carried: {formatDays(b.carriedDays)}
                      {b.carriedExpiresAt && !b.carriedExpired && (
                        <> · expires {fmtDate(b.carriedExpiresAt)}</>
                      )}
                      {b.carriedExpired && <> (expired)</>}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-3 text-xs text-muted-foreground">
                  Unpaid leave · no balance limit
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export function ApplyForm({
  balances,
  joinDate,
  allowForecastedLeaveApply,
  onSuccess,
}: {
  balances: BalanceRow[]
  /// ISO date string ("YYYY-MM-DD...") or null. Drives the PRO_RATED
  /// forecast math when the org allows forecasted-apply.
  joinDate: string | null
  /// When true and the selected leave type is PRO_RATED, render an
  /// extra "Available by <startDate>: X day(s)" hint below the current
  /// balance so employees know how many days they'll actually have
  /// accrued by the date they're applying for.
  allowForecastedLeaveApply: boolean
  onSuccess?: () => void
}) {
  const [leaveTypeId, setLeaveTypeId] = useState<string>(balances[0]?.leaveTypeId ?? "")
  // Pre-fill both dates with today so a single-day "leave today" request
  // is ready to submit; the employee can still change either field.
  const [startDate, setStartDate] = useState<string>(() => todayLocalISO())
  const [endDate, setEndDate] = useState<string>(() => todayLocalISO())
  const [duration, setDuration] = useState<"FULL_DAY" | "MORNING" | "AFTERNOON">("FULL_DAY")
  const [reason, setReason] = useState("")
  const [attachment, setAttachment] = useState<File | null>(null)
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  const selected = useMemo(
    () => balances.find((b) => b.leaveTypeId === leaveTypeId),
    [balances, leaveTypeId],
  )

  /// "Available by <startDate>" hint for PRO_RATED entitlements. Mirrors
  /// the server-side check in leave-application.service:
  ///   forecastedAccrued = forecastAccruedOnDate(entitled, joinDate, asOf)
  ///   availableByDate   = forecastedAccrued + carriedDays - usedDays
  /// Returns null when the hint shouldn't render (org toggle off,
  /// non-PRO_RATED leave type, missing inputs, or asOf <= today — in
  /// which case the existing "Available balance" line is already
  /// authoritative).
  const forecastedAvailable = useMemo(() => {
    if (!allowForecastedLeaveApply) return null
    if (!selected || !selected.paid) return null
    if (selected.accrualMethod !== "PRO_RATED") return null
    if (!startDate) return null
    const asOf = new Date(`${startDate}T00:00:00Z`)
    if (!Number.isFinite(asOf.getTime())) return null
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    if (asOf.getTime() <= today.getTime()) return null
    const forecastedAccrued = forecastAccruedOnDate({
      entitledDays: selected.entitledDays,
      joinDate: joinDate ? new Date(joinDate) : null,
      asOf,
    })
    const carry = selected.carriedExpired ? 0 : selected.carriedDays
    return Math.max(0, forecastedAccrued + carry - selected.usedDays)
  }, [allowForecastedLeaveApply, selected, startDate, joinDate])

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
    if (attachment) fd.set("attachment", attachment)
    startTransition(async () => {
      const res = await submitLeaveAction(fd)
      if (!res.ok) {
        setMessage({ kind: "err", text: res.error })
        return
      }
      setReason("")
      setAttachment(null)
      onSuccess?.()
    })
  }

  return (
    <div className="space-y-3 pt-2">
        <div>
          <Label>Leave type</Label>
          <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
            <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>
              {balances.map((b) => (
                <SelectItem key={b.leaveTypeId} value={b.leaveTypeId}>
                  {b.leaveTypeName} · {b.paid
                    ? `${formatDays(b.availableDays)} day(s) available`
                    : `unpaid · ${formatDays(b.usedDays)} day(s) used`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && (
            <p className="text-xs text-muted-foreground mt-1">
              {selected.paid
                ? `Available balance: ${formatDays(selected.availableDays)} day${selected.availableDays === 1 ? "" : "s"}`
                : `Unpaid leave · ${formatDays(selected.usedDays)} day${selected.usedDays === 1 ? "" : "s"} used so far`}
            </p>
          )}
          {forecastedAvailable !== null && startDate ? (
            <p className="text-xs text-primary mt-0.5">
              Available by {startDate}: {formatDays(forecastedAvailable)} day
              {forecastedAvailable === 1 ? "" : "s"}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="startDate">Start date</Label>
            <Input
              id="startDate"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <Label htmlFor="endDate">End date</Label>
            <Input
              id="endDate"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full"
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

        <div>
          <Label htmlFor="attachment">Attachment (optional)</Label>
          <Input
            id="attachment"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
            onChange={(e) => setAttachment(e.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Upload an MC slip or supporting document. JPG, PNG, WEBP, HEIC, or PDF · max 10 MB.
            {attachment && (
              <span className="ml-1 font-medium text-foreground">
                Selected: {attachment.name}
              </span>
            )}
          </p>
        </div>

        {message && (
          <p className={message.kind === "ok" ? "text-sm text-emerald-600" : "text-sm text-destructive"}>
            {message.text}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {onSuccess && (
            <Button variant="outline" onClick={() => onSuccess()}>Cancel</Button>
          )}
          <Button onClick={submit} disabled={pending || !leaveTypeId || !startDate || !endDate}>
            {pending ? "Submitting…" : "Submit"}
          </Button>
        </div>
    </div>
  )
}

function statusVariant(
  status: string,
): "pending" | "approved" | "rejected" | "outline" {
  if (status === "APPROVED") return "approved"
  if (status === "REJECTED") return "rejected"
  if (status === "PENDING") return "pending"
  return "outline"
}

function ApplicationsCard({
  applications,
  balances,
}: {
  applications: ApplicationRow[]
  balances: BalanceRow[]
}) {
  const [editing, setEditing] = useState<ApplicationRow | null>(null)
  return (
    <>
      <Card>
        <CardHeader><CardTitle>My applications</CardTitle></CardHeader>
        <CardContent className="p-0">
          {applications.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No applications yet.</p>
          ) : (
            <>
              {/* Mobile: stacked cards (one per application). */}
              <div className="space-y-3 p-4 md:hidden">
                {applications.map((a) => {
                  const canEdit = a.status === "PENDING" && a.approvalsCount === 0
                  // Broader than canEdit on purpose — see CancelLeaveButton.
                  const canCancel = a.status === "PENDING"
                  return (
                    <div key={a.id} className="rounded-2xl border border-border/60 bg-card/40 p-3 space-y-2 backdrop-blur-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-foreground">{a.leaveTypeName}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {fmtDate(a.startDate)}
                            {a.startDate !== a.endDate && <> → {fmtDate(a.endDate)}</>}
                            {a.duration !== "FULL_DAY" && (
                              <span className="ml-1">
                                ({a.duration === "MORNING" ? "AM" : "PM"})
                              </span>
                            )}
                          </p>
                        </div>
                        <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                      </div>
                      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                        <span>{a.totalDays} day{a.totalDays === 1 ? "" : "s"}</span>
                        <span>Submitted {fmtDate(a.createdAt)}</span>
                      </div>
                      {a.attachmentUrl && (
                        <a
                          href={a.attachmentUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-xs font-medium text-primary hover:underline"
                        >
                          📎 {a.attachmentName ?? "View attachment"}
                        </a>
                      )}
                      {(canEdit || canCancel) && (
                        <div className="flex items-start justify-end gap-2">
                          {canEdit && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setEditing(a)}
                            >
                              Edit
                            </Button>
                          )}
                          {canCancel && <CancelLeaveButton applicationId={a.id} />}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Desktop / tablet: regular table. */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Dates</TableHead>
                      <TableHead>Days</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Attachment</TableHead>
                      <TableHead>Submitted</TableHead>
                      <TableHead className="text-right"> </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {applications.map((a) => {
                      const canEdit = a.status === "PENDING" && a.approvalsCount === 0
                      // Broader than canEdit on purpose — see CancelLeaveButton.
                      const canCancel = a.status === "PENDING"
                      return (
                        <TableRow key={a.id}>
                          <TableCell className="font-medium">{a.leaveTypeName}</TableCell>
                          <TableCell>
                            {fmtDate(a.startDate)}
                            {a.startDate !== a.endDate && <> → {fmtDate(a.endDate)}</>}
                            {a.duration !== "FULL_DAY" && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                ({a.duration === "MORNING" ? "AM" : "PM"})
                              </span>
                            )}
                          </TableCell>
                          <TableCell>{a.totalDays}</TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                          </TableCell>
                          <TableCell>
                            {a.attachmentUrl ? (
                              <a
                                href={a.attachmentUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-medium text-primary hover:underline"
                              >
                                {a.attachmentName ?? "View"}
                              </a>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>{fmtDate(a.createdAt)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-start justify-end gap-2">
                              {canEdit && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setEditing(a)}
                                >
                                  Edit
                                </Button>
                              )}
                              {canCancel && (
                                <CancelLeaveButton applicationId={a.id} />
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {editing && (
        <EditLeaveDialog
          application={editing}
          balances={balances}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

/// Withdraw a still-pending request. Shown for any PENDING row —
/// unlike Edit, which additionally requires that nobody has reviewed
/// yet: once an approver has acted you can no longer change the dates,
/// but you can still take the request off their queue.
function CancelLeaveButton({ applicationId }: { applicationId: string }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col items-end">
      <ConfirmActionDialog
        title="Cancel this leave request?"
        description="It will be withdrawn from your approver's queue. This can't be undone — you'd need to submit a new request."
        confirmLabel="Yes, cancel it"
        cancelLabel="Keep request"
        triggerLabel="Cancel"
        triggerVariant="outline"
        triggerSize="sm"
        confirmVariant="destructive"
        pending={pending}
        pendingLabel="Cancelling…"
        onConfirm={() => {
          setError(null)
          startTransition(async () => {
            const res = await cancelLeaveAction(applicationId)
            if (!res.ok) setError(res.error)
          })
        }}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function EditLeaveDialog({
  application,
  balances,
  onClose,
}: {
  application: ApplicationRow
  balances: BalanceRow[]
  onClose: () => void
}) {
  const [leaveTypeId, setLeaveTypeId] = useState(application.leaveTypeId)
  const [startDate, setStartDate] = useState(application.startDate.slice(0, 10))
  const [endDate, setEndDate] = useState(application.endDate.slice(0, 10))
  const [duration, setDuration] = useState<"FULL_DAY" | "MORNING" | "AFTERNOON">(application.duration)
  const [reason, setReason] = useState(application.reason ?? "")
  const [attachment, setAttachment] = useState<File | null>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const sameDay = startDate !== "" && startDate === endDate
  const effectiveDuration: "FULL_DAY" | "MORNING" | "AFTERNOON" =
    sameDay ? duration : "FULL_DAY"

  function submit() {
    setError(null)
    const fd = new FormData()
    fd.set("leaveTypeId", leaveTypeId)
    fd.set("startDate", startDate)
    fd.set("endDate", endDate)
    fd.set("duration", effectiveDuration)
    fd.set("reason", reason)
    if (attachment) fd.set("attachment", attachment)
    startTransition(async () => {
      const res = await editLeaveAction(application.id, fd)
      if (!res.ok) {
        setError(res.error)
        return
      }
      onClose()
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit leave application</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Leave type</Label>
            <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {balances.map((b) => (
                  <SelectItem key={b.leaveTypeId} value={b.leaveTypeId}>
                    {b.leaveTypeName} · {b.paid
                      ? `${formatDays(b.availableDays)} day(s) available`
                      : `unpaid · ${formatDays(b.usedDays)} day(s) used`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="editStart">Start date</Label>
              <Input
                id="editStart"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full"
              />
            </div>
            <div>
              <Label htmlFor="editEnd">End date</Label>
              <Input
                id="editEnd"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full"
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
          </div>

          <div>
            <Label htmlFor="editReason">Reason (optional)</Label>
            <Textarea
              id="editReason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="editAttachment">Replace attachment (optional)</Label>
            <Input
              id="editAttachment"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
              onChange={(e) => setAttachment(e.target.files?.[0] ?? null)}
            />
            {application.attachmentUrl && !attachment && (
              <p className="text-xs text-muted-foreground mt-1">
                Current: {application.attachmentName ?? "attached file"}. Upload a new file to replace.
              </p>
            )}
            {attachment && (
              <p className="text-xs font-medium text-foreground mt-1">
                New: {attachment.name}
              </p>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
