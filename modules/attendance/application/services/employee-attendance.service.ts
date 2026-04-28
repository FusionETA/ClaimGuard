import "server-only"

import type {
  AttendanceRecordView,
  EmployeeAttendanceDashboard,
  OTRequestView,
} from "@/modules/attendance/domain/models"

export const employeeAttendanceService = {
  async getEmployeeDashboard(_employeeId: string): Promise<EmployeeAttendanceDashboard> {
    throw new Error("employeeAttendanceService.getEmployeeDashboard: not implemented")
  },

  async getEmployeeHistory(
    _employeeId: string,
    _from: Date,
    _to: Date,
  ): Promise<AttendanceRecordView[]> {
    throw new Error("employeeAttendanceService.getEmployeeHistory: not implemented")
  },

  async getEmployeeOTRecords(_employeeId: string): Promise<OTRequestView[]> {
    throw new Error("employeeAttendanceService.getEmployeeOTRecords: not implemented")
  },
}
