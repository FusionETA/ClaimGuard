import { AlertTriangle, CheckCircle2, FileText } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/attendance/ui/avatar"
import { Badge } from "@/components/attendance/ui/badge"
import { Card, CardContent } from "@/components/attendance/ui/card"
import { CoordsLink } from "@/components/attendance/coords-link"
import { SessionEditorDialog } from "@/components/attendance/session-editor-dialog"
import {
  approvalStatusMeta,
  attendanceStatusMeta,
} from "@/modules/attendance/domain/metadata"
import type {
  ApprovalRequestView,
  AttendanceRecordView,
  ClockEventLite,
} from "@/modules/attendance/domain/models"
import { cn } from "@/lib/utils"

const STATUS_VARIANT: Record<string, string> = {
  ON_TIME: "on-time",
  LATE: "late",
  MISSING: "missing",
  ON_LEAVE: "on-leave",
  CLOCKED_IN: "clocked-in",
  CLOCKED_OUT: "clocked-out",
}

const APPROVAL_VARIANT: Record<string, string> = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
}

const CLOCK_LABEL: Record<string, string> = {
  CLOCK_IN: "Clock in",
  CLOCK_OUT: "Clock out",
  BREAK: "Break",
}

function fmtTime(iso: string | null, tz: string) {
  return iso
    ? new Date(iso).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: tz,
      })
    : "—"
}

function fmtOtDuration(startIso: string, endIso: string): string {
  const diffMin = Math.round(
    (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000,
  )
  if (diffMin <= 0) return ""
  const h = Math.floor(diffMin / 60)
  const m = diffMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function fmtUploadedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

// EmployeeDetailData moved to modules/attendance/domain/models.ts so the
// service that builds it doesn't have to import this view file.
export type { EmployeeDetailData } from "@/modules/attendance/domain/models"
import type { EmployeeDetailData } from "@/modules/attendance/domain/models"

export function EmployeeDetailView({
  data,
  viewerRole,
  timezone,
}: {
  data: EmployeeDetailData
  /** Role of the user viewing this page. Only SUPERVISOR or ADMIN
   *  see the "Edit times" affordance. */
  viewerRole?: "ADMIN" | "SUPERVISOR" | "EMPLOYEE"
  timezone: string
}) {
  const { profile, todayRecord, todayEvents, monthSummary, history, otRecords } = data
  const monthHours = Math.floor(monthSummary.totalMin / 60)
  const monthMins = monthSummary.totalMin % 60
  const canEdit = viewerRole === "SUPERVISOR" || viewerRole === "ADMIN"

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex items-start gap-4">
          <Avatar className="h-14 w-14">
            <AvatarFallback className="text-base">{profile.initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-headline text-xl font-extrabold text-foreground">
                {profile.name}
              </h2>
              <Badge variant={profile.role === "SUPERVISOR" ? "overtime" : "outline"}>
                {profile.role}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{profile.email}</p>
            <div className="mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              {profile.employeeIdRef ? (
                <p>
                  <span className="text-muted-foreground">Employee ID: </span>
                  <span className="font-semibold">{profile.employeeIdRef}</span>
                </p>
              ) : null}
              {profile.jobTitle ? (
                <p>
                  <span className="text-muted-foreground">Title: </span>
                  <span className="font-semibold">{profile.jobTitle}</span>
                </p>
              ) : null}
              {profile.project ? (
                <p>
                  <span className="text-muted-foreground">Project: </span>
                  <span className="font-semibold">{profile.project}</span>
                </p>
              ) : null}
              {profile.supervisorName ? (
                <p>
                  <span className="text-muted-foreground">Reports to: </span>
                  <span className="font-semibold">{profile.supervisorName}</span>
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Today
          </p>
          {todayRecord ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold text-foreground">
                  {fmtTime(todayRecord.timeIn, timezone)} – {fmtTime(todayRecord.timeOut, timezone)}
                </p>
                <div className="flex items-center gap-2">
                  <Badge variant={STATUS_VARIANT[todayRecord.status] as never}>
                    {attendanceStatusMeta[todayRecord.status].label}
                  </Badge>
                  {canEdit ? (
                    <SessionEditorDialog
                      recordId={todayRecord.id}
                      employeeId={todayRecord.employeeId}
                      initialTimeIn={todayRecord.timeIn}
                      initialTimeOut={todayRecord.timeOut}
                      contextLabel={`Today · ${todayRecord.date}`}
                    />
                  ) : null}
                </div>
              </div>
              {todayRecord.project ? (
                <p className="text-xs text-muted-foreground">🛠 {todayRecord.project}</p>
              ) : null}
              {todayRecord.location ? (
                <p className="text-xs text-muted-foreground">📍 {todayRecord.location}</p>
              ) : null}
              {todayRecord.lateByMin ? (
                <p className="text-xs text-tertiary">Late by {todayRecord.lateByMin}m</p>
              ) : null}
              {todayRecord.notes ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                  <p className="font-bold">⚠ Off-site events</p>
                  <pre className="mt-1 whitespace-pre-wrap font-sans">{todayRecord.notes}</pre>
                </div>
              ) : null}
              {todayRecord.remark ? (
                <div className="rounded-md border border-sky-200 bg-sky-50 p-2 text-xs text-sky-900">
                  <p className="font-bold">✏️ Adjustment request</p>
                  <pre className="mt-1 whitespace-pre-wrap font-sans">{todayRecord.remark}</pre>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No clock-in yet today.</p>
          )}

          {todayEvents.length > 0 ? (
            <div className="mt-3 border-t border-border/60 pt-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Events today
              </p>
              <div className="space-y-1.5">
                {todayEvents.map((e) => (
                  <div key={e.id} className="flex items-center gap-2">
                    <Badge
                      variant={
                        e.kind === "CLOCK_IN"
                          ? "clocked-in"
                          : e.kind === "CLOCK_OUT"
                            ? "clocked-out"
                            : "pending"
                      }
                    >
                      {e.kind === "BREAK" && e.breakSubtype === "end"
                        ? "Break end"
                        : e.kind === "BREAK" && e.breakSubtype === "start"
                          ? "Break start"
                          : CLOCK_LABEL[e.kind]}
                    </Badge>
                    <span className="text-xs font-semibold text-foreground">
                      {fmtTime(e.eventAt, timezone)}
                    </span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {e.status === "PENDING"
                        ? "Pending"
                        : e.status === "APPROVED"
                          ? "Approved"
                          : "Rejected"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>

        <Card className="p-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            This month
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="font-headline text-2xl font-extrabold text-foreground">
                {monthHours}h <span className="text-base">{monthMins}m</span>
              </p>
              <p className="text-[11px] text-muted-foreground">Total worked</p>
            </div>
            <div>
              <p className="font-headline text-2xl font-extrabold text-success">
                {monthSummary.onTime}
              </p>
              <p className="text-[11px] text-muted-foreground">On time</p>
            </div>
            <div>
              <p className="font-headline text-2xl font-extrabold text-tertiary">
                {monthSummary.late}
              </p>
              <p className="text-[11px] text-muted-foreground">Late</p>
            </div>
            <div>
              <p className="font-headline text-2xl font-extrabold text-destructive">
                {monthSummary.missing}
              </p>
              <p className="text-[11px] text-muted-foreground">Missing</p>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardContent className="p-4">
          <p className="mb-3 text-sm font-bold text-foreground">Recent attendance</p>
          {history.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No attendance records in the last 30 days.
            </p>
          ) : (
            <div className="space-y-1">
              {history.slice(0, 30).map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border-l-4 px-3 py-2",
                    r.status === "ON_TIME"
                      ? "border-l-success"
                      : r.status === "LATE"
                        ? "border-l-tertiary"
                        : "border-l-destructive",
                  )}
                >
                  {r.status === "MISSING" ? (
                    <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                  ) : (
                    <CheckCircle2
                      className={cn(
                        "h-4 w-4 shrink-0",
                        r.status === "ON_TIME" ? "text-success" : "text-tertiary",
                      )}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {r.date}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {fmtTime(r.timeIn, timezone)}{" "}
                      {r.timeOut ? `– ${fmtTime(r.timeOut, timezone)}` : ""}{" "}
                      {r.project ? `• ${r.project}` : ""}
                    </p>
                    {r.clockInLat != null && r.clockInLng != null ? (
                      <div className="mt-0.5">
                        <CoordsLink
                          lat={r.clockInLat}
                          lng={r.clockInLng}
                          label="Clock-in map"
                        />
                      </div>
                    ) : null}
                    {r.timeOut &&
                    r.clockOutLat != null &&
                    r.clockOutLng != null ? (
                      <div className="mt-0.5">
                        <CoordsLink
                          lat={r.clockOutLat}
                          lng={r.clockOutLng}
                          label="Clock-out map"
                        />
                      </div>
                    ) : null}
                    {r.notes ? (
                      <p className="mt-1 text-[11px] font-semibold text-amber-700">
                        ⚠ {r.notes.split("\n").length} off-site remark
                        {r.notes.split("\n").length > 1 ? "s" : ""}
                      </p>
                    ) : null}
                    {r.remark ? (
                      <p className="mt-1 text-[11px] font-semibold text-sky-700">
                        ✏️ Adjustment request
                      </p>
                    ) : null}
                  </div>
                  <Badge variant={STATUS_VARIANT[r.status] as never}>
                    {attendanceStatusMeta[r.status].label}
                  </Badge>
                  {canEdit ? (
                    <SessionEditorDialog
                      recordId={r.id}
                      employeeId={r.employeeId}
                      initialTimeIn={r.timeIn}
                      initialTimeOut={r.timeOut}
                      triggerLabel="Edit"
                      contextLabel={`Record · ${r.date}`}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <p className="text-sm font-bold text-foreground">OT &amp; replacements</p>
            <span className="text-xs text-muted-foreground">{otRecords.length} entries</span>
          </div>
          {otRecords.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No overtime entries.
            </p>
          ) : (
            <div className="space-y-2">
              {otRecords.map((r) => (
                <div
                  key={r.id}
                  className="flex items-start gap-3 border-b border-border/50 pb-2 last:border-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-foreground">{r.title}</p>
                    <p className="text-xs text-muted-foreground">
                      OT • {r.date}
                    </p>
                    {r.otStartAt && r.otEndAt ? (
                      <p className="text-xs font-medium text-foreground">
                        {fmtTime(r.otStartAt, timezone)} – {fmtTime(r.otEndAt, timezone)} · {fmtOtDuration(r.otStartAt, r.otEndAt)}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted-foreground">{r.detail}</p>
                    {r.attachments.length > 0 && (
                      <div className="mt-2 flex gap-6">
                        {(["JUSTIFICATION", "EVIDENCE"] as const).map((kind) => {
                          const items = r.attachments.filter((a) => a.kind === kind)
                          return (
                            <div key={kind} className="space-y-0.5 min-w-0">
                              <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                                {kind === "JUSTIFICATION" ? "Before" : "After"}
                              </p>
                              {items.length === 0 ? (
                                <p className="text-[10px] text-muted-foreground">None</p>
                              ) : items.map((a) => (
                                <a
                                  key={a.id}
                                  href={a.fileUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                                >
                                  <FileText className="h-3 w-3 shrink-0" />
                                  <div className="min-w-0">
                                    <span className="max-w-[160px] truncate block">{a.fileName}</span>
                                    {a.uploadedAt ? (
                                      <span className="text-[10px] text-muted-foreground font-normal">
                                        {fmtUploadedAt(a.uploadedAt)}
                                      </span>
                                    ) : null}
                                  </div>
                                </a>
                              ))}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <Badge variant={APPROVAL_VARIANT[r.status] as never}>
                    {approvalStatusMeta[r.status].label}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
