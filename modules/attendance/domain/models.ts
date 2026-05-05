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

export type AttendanceRecordView = {
  id: string
  employeeId: string
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
  lateMinutes: number | null
  offsetRef: string | null
  reviewNotes: string | null
  submittedAt: string
  reviewedAt: string | null
}

export type AttendanceProjectView = {
  id: string
  name: string
  latitude: number | null
  longitude: number | null
}

export type ClockEventLite = {
  id: string
  kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK"
  status: ApprovalStatus
  eventAt: string
  /** For kind="BREAK", whether this event is the start or end of the break. */
  breakSubtype: "start" | "end" | null
}

export type EmployeeAttendanceDashboard = {
  today: AttendanceRecordView | null
  weekToDate: AttendanceRecordView[]
  todayEvents: ClockEventLite[]
  recentOT: ApprovalRequestView[]
  geofenceRadiusMeters: number
  activeProjectCoords: { latitude: number | null; longitude: number | null } | null
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
