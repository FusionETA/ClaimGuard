export const attendanceStatuses = [
  "ON_TIME",
  "LATE",
  "MISSING",
  "CLOCKED_IN",
  "CLOCKED_OUT",
  "ON_LEAVE",
] as const

export const otRequestTypes = [
  "LATE_REPLACEMENT",
  "OT_OFFSET",
  "UNRESOLVED",
] as const

export const otStatuses = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "OFFSET",
  "UNRESOLVED",
] as const

export type AttendanceStatus = (typeof attendanceStatuses)[number]
export type OTRequestType = (typeof otRequestTypes)[number]
export type OTStatus = (typeof otStatuses)[number]

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

export type OTRequestView = {
  id: string
  employeeId: string
  employeeName?: string
  reviewerId: string | null
  type: OTRequestType
  date: string
  title: string
  detail: string
  lateMinutes: number | null
  offsetRef: string | null
  status: OTStatus
  reviewNotes: string | null
  submittedAt: string
  reviewedAt: string | null
}

export const approvalKinds = ["OT", "CLOCK"] as const
export type ApprovalKind = (typeof approvalKinds)[number]

export const clockEventTypes = ["CLOCK_IN", "CLOCK_OUT", "BREAK"] as const
export type ClockEventType = (typeof clockEventTypes)[number]

export type ApprovalRequestView = {
  id: string
  kind: ApprovalKind
  employeeId: string
  employeeName: string
  date: string
  title: string
  detail: string
  status: "PENDING" | "APPROVED" | "REJECTED"
  // OT-specific
  otType?: OTRequestType
  // Clock-specific
  clockEvent?: ClockEventType
  location?: string
  submittedAt: string
}

export type EmployeeAttendanceDashboard = {
  today: AttendanceRecordView | null
  weekToDate: AttendanceRecordView[]
  pendingOT: OTRequestView[]
  recentOT: OTRequestView[]
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
