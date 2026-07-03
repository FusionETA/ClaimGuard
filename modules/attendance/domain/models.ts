export const attendanceStatuses = [
  "ON_TIME",
  "LATE",
  "MISSING",
  "CLOCKED_IN",
  "CLOCKED_OUT",
  "ON_LEAVE",
] as const

export const approvalKinds = ["CLOCK_IN", "CLOCK_OUT", "BREAK", "OT"] as const
export const approvalStatuses = ["PENDING", "APPROVED", "REJECTED"] as const
export const otSubtypes = ["LATE_REPLACEMENT", "OT_OFFSET", "UNRESOLVED"] as const

export type AttendanceStatus = (typeof attendanceStatuses)[number]
export type ApprovalKind = (typeof approvalKinds)[number]
export type ApprovalStatus = (typeof approvalStatuses)[number]
export type OTSubtype = (typeof otSubtypes)[number]

export type AttendanceSessionView = {
  id: string
  startedAt: string
  endedAt: string | null
  durationMin: number | null
  status: AttendanceStatus
  clockInLat: number | null
  clockInLng: number | null
  clockOutLat: number | null
  clockOutLng: number | null
  clockInNotes: string | null
  clockOutNotes: string | null
}

export type AttendanceRecordView = {
  id: string
  employeeId: string
  /** Populated when the query joins the employee row (e.g. org history). Null for per-employee queries. */
  name: string | null
  date: string
  timeIn: string | null
  timeOut: string | null
  /** True if there is at least one open BreakSession (startedAt set, endedAt null). */
  onBreak: boolean
  /** ISO timestamp of the currently open break, if any. Null when not on break. */
  currentBreakStartedAt: string | null
  /** Total minutes spent on completed breaks today. */
  breakMin: number
  durationMin: number | null
  lateByMin: number | null
  location: string | null
  project: string | null
  status: AttendanceStatus
  /** System-captured context — off-site warnings, clock-in/out tags. Read-only for employees. */
  notes: string | null
  /** Employee's free-form remark about their shift (separate from notes). */
  remark: string | null
  /** GPS coords captured at clock-in / clock-out, when the employee's
   *  policy enabled location capture for the event. Null when GPS
   *  wasn't available or the policy disabled capture. Surfaced in the
   *  employee detail view so admins can verify locations on a map. */
  clockInLat: number | null
  clockInLng: number | null
  clockOutLat: number | null
  clockOutLng: number | null
  /** All clock-in/out sessions for this day, ordered by startedAt asc.
   *  Most callers can ignore this and use the rollup fields above. */
  sessions: AttendanceSessionView[]
}

export type ChainHistoryEntry = {
  step: number
  approverId: string
  approverName: string
  reviewedAt: string
  status: "APPROVED" | "REJECTED"
  notes: string | null
}

export type ApprovalRequestView = {
  id: string
  kind: ApprovalKind
  status: ApprovalStatus
  employeeId: string
  employeeName: string
  reviewerId: string | null
  date: string // ISO yyyy-mm-dd
  eventAt: string | null
  title: string
  detail: string
  location: string | null
  project: string | null
  otSubtype: OTSubtype | null
  /// CASH or TIME_BANK snapshot for OT requests. Null for non-OT or legacy
  /// rows submitted before the snapshot was added.
  otPayoutMethod: "CASH" | "TIME_BANK" | null
  /// Submitted OT time range. Null for non-OT or legacy rows.
  otStartAt: string | null
  otEndAt: string | null
  /// AttendanceRecord id whose selfie can be fetched via
  /// /api/attendance/selfie/{id}. Null when there's no selfie attached
  /// (Office Workers, Hourly Workers whose upload failed, or non-CLOCK_IN
  /// kinds). Drives whether the UI shows the thumbnail.
  selfieAttendanceRecordId: string | null
  lateMinutes: number | null
  /// GPS of the clock event, joined from the AttendanceRecord by
  /// backfillLateMinutes (clock-in coords for CLOCK_IN, clock-out for
  /// CLOCK_OUT). Null for OT / legacy rows or when no coords were captured.
  /// Drives the "Open in map" link on the approval detail.
  latitude: number | null
  longitude: number | null
  offsetRef: string | null
  reviewNotes: string | null
  submittedAt: string
  reviewedAt: string | null
  /** Per-step approval audit. Null on legacy / auto-approved rows. */
  chainHistory: ChainHistoryEntry[] | null
  /** 1-indexed step number currently waiting for review. Null when finalised. */
  currentStep: number | null
  /** Total number of steps in the resolved chain (length 1 for fallback / legacy). */
  totalSteps: number
  /** When `currentStep` is set, the names of the approvers who can act on it. */
  currentStepApproverNames: string[]
  /** When `currentStep` is set, the user IDs of the approvers who can act on it. */
  currentStepApproverIds: string[]
}

export type AttendanceProjectView = {
  id: string
  name: string
  latitude: number | null
  longitude: number | null
  /** Comma-separated ISO weekday numbers (1=Mon…7=Sun) from XeroProject.workingDays.
   *  Null means all weekdays apply (use default). Passed to the client so it can
   *  check whether today is a rest day before clock-in. */
  workingDays: string | null
}

export type ClockEventLite = {
  id: string
  kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK"
  status: ApprovalStatus
  eventAt: string
  /** For kind="BREAK", whether this event is the start or end of the break. */
  breakSubtype: "start" | "end" | null
  /** Reviewer's notes when the request was finalised — surfaces the
   *  rejection reason on the employee's dashboard. Null for pending or
   *  un-annotated approvals. */
  reviewNotes: string | null
  /** Reviewer's display name (best-effort) for rejection banners. */
  reviewerName: string | null
}

export type EmployeeAttendanceDashboard = {
  today: AttendanceRecordView | null
  weekToDate: AttendanceRecordView[]
  todayEvents: ClockEventLite[]
  recentOT: ApprovalRequestView[]
  geofenceRadiusMeters: number
  activeProjectCoords: { latitude: number | null; longitude: number | null } | null
  /// Set when there's an unresolved (PENDING) clock-in / clock-out / break
  /// approval on today's date — used by the clock card to disable the
  /// next-event button until the supervisor reviews. `null` means there's
  /// nothing pending and the employee can act freely. OT approvals are
  /// excluded — they don't gate subsequent clocking activity.
  pendingApproval: { id: string; kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK" } | null
}

export type SupervisorTeamOverview = {
  teamSize: number
  presentToday: number
  lateToday: number
  onLeaveToday: number
  pendingApprovals: number
  team: Array<{
    employeeId: string
    name: string
    initials: string
    today: AttendanceRecordView | null
  }>
}

export type AdminOrgOverview = {
  headcount: number
  presentToday: number
  lateToday: number
  onLeaveToday: number
  pendingApprovals: number
  byProject: Array<{
    project: string
    headcount: number
    presentToday: number
    lateToday: number
  }>
}

export type RollCallPerson = {
  id: string
  name: string
  employeeId: string
  jobTitle: string
  project: string
  // Late-only metadata.
  lateByMin?: number
  timeIn?: string
}

export type TodayRollCall = {
  late: RollCallPerson[]
  onLeave: RollCallPerson[]
  notClockedIn: RollCallPerson[]
}

/**
 * View model for the per-employee attendance detail page. Lives here (not in
 * the React view file) so the service `employee-detail-loader` can depend on
 * it without importing the component module — keeps the dependency direction
 * pointing from view → domain, never the other way.
 */
export type EmployeeDetailData = {
  profile: {
    name: string
    email: string
    role: string
    initials: string
    jobTitle: string | null
    project: string | null
    employeeIdRef: string | null
    supervisorName: string | null
  }
  todayRecord: AttendanceRecordView | null
  todayEvents: ClockEventLite[]
  monthSummary: {
    totalMin: number
    onTime: number
    late: number
    missing: number
  }
  history: AttendanceRecordView[]
  otRecords: ApprovalRequestView[]
}

// ─── Shifts ────────────────────────────────────────────────────────────

/**
 * Shift view-model used by the admin shift-management screen.
 * Mirrors the `Shift` Prisma model with the Decimal-free client-safe
 * shape — no Decimals or Dates on this model (times are HH:MM strings
 * to match the schema; workingDays is a comma-separated ISO-weekday
 * string).
 */
export type ShiftView = {
  id: string
  organizationId: string
  projectId: string
  projectName: string
  name: string
  /// HH:MM (24-hour). Clock-in after this time → LATE detection.
  startTime: string
  /// HH:MM (24-hour). Used to compute expected daily minutes.
  endTime: string
  /// Comma-separated ISO weekday numbers (1=Mon … 7=Sun). Null =
  /// inherit from project/org default working-day config.
  workingDays: string | null
  /// Deducted from expected daily minutes.
  lunchBreakMin: number
  /// Exactly one shift per project is the default (used when a team
  /// member has no per-member `EmployeeTeamMembership.shiftId`).
  isDefault: boolean
  /// Number of `EmployeeTeamMembership` rows currently pointing at
  /// this shift. Surfaced so the admin sees "3 employees assigned"
  /// before they try to delete.
  assignedMemberCount: number
  createdAt: string
  updatedAt: string
}

/**
 * Grouping shape returned by the admin shifts page — one entry per
 * project the admin can see, with the project's shifts listed under
 * it. Empty shifts array is legal (project has no shifts yet).
 */
export type ShiftsByProject = {
  projectId: string
  projectName: string
  shifts: ShiftView[]
}
