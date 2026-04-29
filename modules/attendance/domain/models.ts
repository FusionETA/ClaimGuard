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
}

export type ClockEventLite = {
  id: string
  kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK"
  status: ApprovalStatus
  eventAt: string
}

export type EmployeeAttendanceDashboard = {
  today: AttendanceRecordView | null
  weekToDate: AttendanceRecordView[]
  todayEvents: ClockEventLite[]
  recentOT: ApprovalRequestView[]
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
