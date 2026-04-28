import "server-only"

import type {
  AttendanceRecordView,
  OTRequestView,
  SupervisorTeamOverview,
} from "@/modules/attendance/domain/models"

export const supervisorAttendanceService = {
  async getTeamOverview(_supervisorId: string): Promise<SupervisorTeamOverview> {
    throw new Error("supervisorAttendanceService.getTeamOverview: not implemented")
  },

  async getPendingApprovalsForSupervisor(
    _supervisorId: string,
  ): Promise<OTRequestView[]> {
    throw new Error(
      "supervisorAttendanceService.getPendingApprovalsForSupervisor: not implemented",
    )
  },

  async getEmployeeDrilldown(
    _supervisorId: string,
    _employeeId: string,
  ): Promise<{
    history: AttendanceRecordView[]
    otRecords: OTRequestView[]
  }> {
    throw new Error("supervisorAttendanceService.getEmployeeDrilldown: not implemented")
  },
}
