import "server-only"

import type {
  AttendanceRecordView,
  AttendanceStatus,
  OTRequestType,
  OTRequestView,
  OTStatus,
} from "@/modules/attendance/domain/models"

// ---------------------------------------------------------------------------
// Stub repository — wired up alongside the UI port in step 3+.
// Mirrors modules/claims/infrastructure/claim.repository.ts (plain object,
// no interface, direct getPrismaClient() usage inside each method).
// ---------------------------------------------------------------------------

export type UpsertClockEventInput = {
  employeeId: string
  date: Date
  timeIn?: Date
  timeOut?: Date
  status?: AttendanceStatus
  location?: string
  project?: string
}

export type CreateOTRequestInput = {
  employeeId: string
  type: OTRequestType
  date: Date
  title: string
  detail: string
  lateMinutes?: number
  offsetRef?: string
}

export type ReviewOTRequestInput = {
  otRequestId: string
  reviewerId: string
  status: OTStatus
  reviewNotes?: string
}

export const attendanceRepository = {
  async getAttendanceForEmployee(
    _employeeId: string,
    _from: Date,
    _to: Date,
  ): Promise<AttendanceRecordView[]> {
    throw new Error("attendanceRepository.getAttendanceForEmployee: not implemented")
  },

  async upsertClockEvent(_input: UpsertClockEventInput): Promise<AttendanceRecordView> {
    throw new Error("attendanceRepository.upsertClockEvent: not implemented")
  },

  async createOTRequest(_input: CreateOTRequestInput): Promise<OTRequestView> {
    throw new Error("attendanceRepository.createOTRequest: not implemented")
  },

  async reviewOTRequest(_input: ReviewOTRequestInput): Promise<OTRequestView> {
    throw new Error("attendanceRepository.reviewOTRequest: not implemented")
  },

  async getOTRequestsForEmployee(_employeeId: string): Promise<OTRequestView[]> {
    throw new Error("attendanceRepository.getOTRequestsForEmployee: not implemented")
  },

  async listPendingOTForSupervisor(_supervisorId: string): Promise<OTRequestView[]> {
    throw new Error("attendanceRepository.listPendingOTForSupervisor: not implemented")
  },

  async listPendingOTForAdmin(): Promise<OTRequestView[]> {
    throw new Error("attendanceRepository.listPendingOTForAdmin: not implemented")
  },

  async getTeamMembers(_supervisorId: string): Promise<
    Array<{ employeeId: string; name: string; initials: string }>
  > {
    throw new Error("attendanceRepository.getTeamMembers: not implemented")
  },
}
