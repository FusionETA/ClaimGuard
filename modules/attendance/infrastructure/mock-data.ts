import type {
  AdminOrgOverview,
  ApprovalRequestView,
  AttendanceRecordView,
  EmployeeAttendanceDashboard,
  OTRequestView,
  SupervisorTeamOverview,
} from "@/modules/attendance/domain/models"

// ---------------------------------------------------------------------------
// Temporary mock data backing the attendance services.
// Replace with real Prisma queries as part of step 4.
// Source: attendance-next/data/mockData.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mutable mock store. In-process state — resets on server restart.
// TODO(step-4): persist working hours per-organisation in Prisma; persist
// approval reviews via attendanceRepository.
// ---------------------------------------------------------------------------

const workingHours = { start: "09:00", end: "18:00" }

export function getMockWorkingHours() {
  return { ...workingHours }
}

export function setMockWorkingHours(start: string, end: string) {
  workingHours.start = start
  workingHours.end = end
}

export function reviewMockApproval(
  id: string,
  status: "APPROVED" | "REJECTED",
) {
  const item = mockPendingApprovals.find((a) => a.id === id)
  if (item) {
    item.status = status
  }
}

export const mockProjects = [
  { id: "1", name: "Main Office HQ", address: "450 Serra Mall, Stanford", radius: 300 },
  { id: "2", name: "Skyline Tower Construction", address: "123 Tower Rd, Kuala Lumpur", radius: 200 },
  { id: "3", name: "Green Valley Office", address: "78 Green Ave, Petaling Jaya", radius: 250 },
] as const

export const mockAttendanceHistory: AttendanceRecordView[] = [
  {
    id: "att-1",
    employeeId: "emp-1",
    date: "Mon, Oct 23",
    timeIn: "08:54 AM",
    timeOut: "05:32 PM",
    durationMin: 518,
    lateByMin: null,
    location: "Office • Downtown HQ",
    project: "Cloud Migration Alpha",
    status: "ON_TIME",
    notes: null,
  },
  {
    id: "att-2",
    employeeId: "emp-1",
    date: "Fri, Oct 20",
    timeIn: "09:12 AM",
    timeOut: "06:05 PM",
    durationMin: 533,
    lateByMin: 12,
    location: "Remote • Home Office",
    project: "Internal CRM Audit",
    status: "LATE",
    notes: null,
  },
  {
    id: "att-3",
    employeeId: "emp-1",
    date: "Thu, Oct 19",
    timeIn: "08:48 AM",
    timeOut: "05:15 PM",
    durationMin: 507,
    lateByMin: null,
    location: "Office • Downtown HQ",
    project: "Cloud Migration Alpha",
    status: "ON_TIME",
    notes: null,
  },
  {
    id: "att-4",
    employeeId: "emp-1",
    date: "Wed, Oct 18",
    timeIn: "09:00 AM",
    timeOut: null,
    durationMin: null,
    lateByMin: null,
    location: "Partial Record",
    project: "Internal CRM Audit",
    status: "MISSING",
    notes: null,
  },
]

export const mockOTRecords: OTRequestView[] = [
  {
    id: "ot-1",
    employeeId: "emp-1",
    employeeName: "Alexander James",
    reviewerId: null,
    type: "LATE_REPLACEMENT",
    date: "Oct 24",
    title: "Late Work Replacement",
    detail: "45m Delay",
    lateMinutes: 45,
    offsetRef: "-45m",
    status: "OFFSET",
    reviewNotes: null,
    submittedAt: "2023-10-24T08:00:00Z",
    reviewedAt: null,
  },
  {
    id: "ot-2",
    employeeId: "emp-1",
    employeeName: "Alexander James",
    reviewerId: "sup-1",
    type: "OT_OFFSET",
    date: "Oct 25",
    title: "Overtime Offset",
    detail: "08:00 - 08:45",
    lateMinutes: null,
    offsetRef: "+45m",
    status: "APPROVED",
    reviewNotes: null,
    submittedAt: "2023-10-25T09:00:00Z",
    reviewedAt: "2023-10-25T10:00:00Z",
  },
  {
    id: "ot-3",
    employeeId: "emp-1",
    employeeName: "Alexander James",
    reviewerId: null,
    type: "UNRESOLVED",
    date: "Oct 19",
    title: "Missing Replacement",
    detail: "1h 15m Late",
    lateMinutes: 75,
    offsetRef: null,
    status: "UNRESOLVED",
    reviewNotes: null,
    submittedAt: "2023-10-19T08:00:00Z",
    reviewedAt: null,
  },
]

export const mockPendingApprovals: ApprovalRequestView[] = [
  {
    id: "ap-1",
    kind: "OT",
    otType: "OT_OFFSET",
    employeeId: "emp-2",
    employeeName: "Marcus Holloway",
    date: "Oct 24, 2023",
    title: "3.5 hours overtime",
    detail: "Urgent server maintenance required due to legacy API issues affecting production.",
    status: "PENDING",
    submittedAt: "2023-10-24T18:00:00Z",
  },
  {
    id: "ap-2",
    kind: "OT",
    otType: "OT_OFFSET",
    employeeId: "emp-3",
    employeeName: "David Chen",
    date: "Oct 22, 2023",
    title: "2 hours overtime",
    detail: "QA regression testing needed before product release.",
    status: "PENDING",
    submittedAt: "2023-10-22T17:00:00Z",
  },
  {
    id: "ap-3",
    kind: "OT",
    otType: "LATE_REPLACEMENT",
    employeeId: "emp-4",
    employeeName: "Sarah Jenkins",
    date: "Oct 23, 2023",
    title: "Missing clock-out correction",
    detail: "Mobile app crashed while clocking out. GPS data confirms I was at the location.",
    status: "PENDING",
    submittedAt: "2023-10-23T17:15:00Z",
  },
  {
    id: "ap-4",
    kind: "CLOCK",
    clockEvent: "CLOCK_IN",
    employeeId: "emp-5",
    employeeName: "Priya Nair",
    date: "Oct 25, 2023",
    title: "Clock-in 09:02",
    detail: "GPS within 30m of HQ Main",
    location: "HQ Main",
    status: "PENDING",
    submittedAt: "2023-10-25T09:02:00Z",
  },
  {
    id: "ap-5",
    kind: "CLOCK",
    clockEvent: "BREAK",
    employeeId: "emp-5",
    employeeName: "Priya Nair",
    date: "Oct 25, 2023",
    title: "Break check 12:31",
    detail: "Confirmed on-site",
    location: "HQ Main",
    status: "PENDING",
    submittedAt: "2023-10-25T12:31:00Z",
  },
  {
    id: "ap-6",
    kind: "CLOCK",
    clockEvent: "CLOCK_OUT",
    employeeId: "emp-2",
    employeeName: "Marcus Holloway",
    date: "Oct 24, 2023",
    title: "Clock-out 19:45",
    detail: "End of overtime shift",
    location: "HQ Main",
    status: "PENDING",
    submittedAt: "2023-10-24T19:45:00Z",
  },
]

export const mockTeam: SupervisorTeamOverview = {
  teamSize: 6,
  presentToday: 4,
  lateToday: 1,
  onLeaveToday: 1,
  pendingApprovals: mockPendingApprovals.length,
  team: [
    { employeeId: "emp-2", name: "Sarah Jenkins", initials: "SJ", today: null },
    { employeeId: "emp-3", name: "Marcus Thorne", initials: "MT", today: null },
    { employeeId: "emp-4", name: "Elena Rodriguez", initials: "ER", today: null },
    { employeeId: "emp-5", name: "David Chen", initials: "DC", today: null },
    { employeeId: "emp-6", name: "Priya Nair", initials: "PN", today: null },
    { employeeId: "emp-7", name: "Jordan Lee", initials: "JL", today: null },
  ],
}

export const mockEmployeeDashboard: EmployeeAttendanceDashboard = {
  today: null,
  weekToDate: mockAttendanceHistory.slice(0, 3),
  pendingOT: [],
  recentOT: mockOTRecords,
}

export const mockOrgOverview: AdminOrgOverview = {
  headcount: 142,
  presentToday: 124,
  lateToday: 6,
  onLeaveToday: 8,
  pendingApprovals: mockPendingApprovals.length,
  byProject: [
    { project: "Cloud Migration Alpha", headcount: 38, presentToday: 34, lateToday: 2 },
    { project: "Internal CRM Audit", headcount: 22, presentToday: 19, lateToday: 1 },
    { project: "Skyline Tower", headcount: 41, presentToday: 36, lateToday: 2 },
    { project: "Green Valley Office", headcount: 27, presentToday: 23, lateToday: 1 },
    { project: "HQ Operations", headcount: 14, presentToday: 12, lateToday: 0 },
  ],
}
