import type {
  ApprovalKind,
  ApprovalStatus,
  AttendanceStatus,
  OTSubtype,
} from "@/modules/attendance/domain/models"

export const attendanceStatusMeta: Record<
  AttendanceStatus,
  { label: string; description: string; tone: string }
> = {
  ON_TIME: {
    label: "On time",
    description: "Clocked in within the grace window.",
    tone: "success",
  },
  LATE: {
    label: "Late",
    description: "Clocked in after the grace window.",
    tone: "warning",
  },
  MISSING: {
    label: "Missing",
    description: "No clock-in recorded for the day.",
    tone: "danger",
  },
  CLOCKED_IN: {
    label: "Clocked in",
    description: "Currently on the clock.",
    tone: "info",
  },
  CLOCKED_OUT: {
    label: "Clocked out",
    description: "Day completed.",
    tone: "neutral",
  },
  ON_LEAVE: {
    label: "On leave",
    description: "Approved leave for the day.",
    tone: "muted",
  },
}

export const approvalKindMeta: Record<
  ApprovalKind,
  { label: string; description: string }
> = {
  CLOCK_IN: { label: "Clock in", description: "Start of shift" },
  CLOCK_OUT: { label: "Clock out", description: "End of shift" },
  BREAK: { label: "Break check", description: "On-site confirmation" },
  OT: { label: "Overtime", description: "Overtime / replacement request" },
}

export const otSubtypeMeta: Record<
  OTSubtype,
  { label: string; description: string }
> = {
  LATE_REPLACEMENT: {
    label: "Late replacement",
    description: "Make up time for a late clock-in.",
  },
  OT_OFFSET: {
    label: "OT offset",
    description: "Offset overtime against a future absence.",
  },
  UNRESOLVED: {
    label: "Unresolved",
    description: "Outstanding entry awaiting follow-up.",
  },
}

export const approvalStatusMeta: Record<
  ApprovalStatus,
  { label: string; tone: string }
> = {
  PENDING: { label: "Pending", tone: "info" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
}
