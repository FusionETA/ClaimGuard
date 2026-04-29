import "server-only"

import type {
  AttendanceRecordView,
  EmployeeAttendanceDashboard,
  OTRequestView,
} from "@/modules/attendance/domain/models"
import {
  getMockWorkingHours,
  mockAttendanceHistory,
  mockEmployeeDashboard,
  mockOTRecords,
} from "@/modules/attendance/infrastructure/mock-data"

// TODO(step-4): replace mock returns with attendanceRepository calls.

export const employeeAttendanceService = {
  async getEmployeeDashboard(_employeeId: string): Promise<EmployeeAttendanceDashboard> {
    return mockEmployeeDashboard
  },

  async getEmployeeHistory(
    _employeeId: string,
    _from: Date,
    _to: Date,
  ): Promise<AttendanceRecordView[]> {
    return mockAttendanceHistory
  },

  async getEmployeeOTRecords(_employeeId: string): Promise<OTRequestView[]> {
    return mockOTRecords
  },

  async getWorkingHours(): Promise<{ start: string; end: string }> {
    return getMockWorkingHours()
  },
}
