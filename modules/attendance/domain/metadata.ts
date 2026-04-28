import type {
  AttendanceStatus,
  OTRequestType,
  OTStatus,
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

export const otTypeMeta: Record<
  OTRequestType,
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

export const otStatusMeta: Record<
  OTStatus,
  { label: string; tone: string }
> = {
  PENDING: { label: "Pending", tone: "info" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
  OFFSET: { label: "Offset", tone: "neutral" },
  UNRESOLVED: { label: "Unresolved", tone: "warning" },
}
