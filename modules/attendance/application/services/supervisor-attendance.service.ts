import "server-only"

import type {
  AttendanceRecordView,
  OTRequestView,
  SupervisorTeamOverview,
} from "@/modules/attendance/domain/models"
import {
  mockAttendanceHistory,
  mockOTRecords,
  mockPendingApprovals,
  mockTeam,
} from "@/modules/attendance/infrastructure/mock-data"

// TODO(step-4): replace mock returns with attendanceRepository calls.

export const supervisorAttendanceService = {
  async getTeamOverview(_supervisorId: string): Promise<SupervisorTeamOverview> {
    return mockTeam
  },

  async getPendingApprovalsForSupervisor(
    _supervisorId: string,
  ): Promise<OTRequestView[]> {
    return mockPendingApprovals
  },

  async getEmployeeDrilldown(
    _supervisorId: string,
    _employeeId: string,
  ): Promise<{
    history: AttendanceRecordView[]
    otRecords: OTRequestView[]
  }> {
    return {
      history: mockAttendanceHistory,
      otRecords: mockOTRecords,
    }
  },
}
