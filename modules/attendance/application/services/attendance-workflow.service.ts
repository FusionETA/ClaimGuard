import "server-only"

import { z } from "zod"

import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type {
  AttendanceRecordView,
  OTRequestView,
} from "@/modules/attendance/domain/models"
import { otRequestTypes, otStatuses } from "@/modules/attendance/domain/models"

export const clockInSchema = z.object({
  employeeId: z.string().min(1),
  at: z.coerce.date(),
  location: z.string().optional(),
  project: z.string().optional(),
})

export const clockOutSchema = z.object({
  employeeId: z.string().min(1),
  at: z.coerce.date(),
})

export const submitOTSchema = z.object({
  employeeId: z.string().min(1),
  type: z.enum(otRequestTypes),
  date: z.coerce.date(),
  title: z.string().min(1),
  detail: z.string().min(1),
  lateMinutes: z.number().int().nonnegative().optional(),
  offsetRef: z.string().optional(),
})

export const reviewOTSchema = z.object({
  otRequestId: z.string().min(1),
  reviewerId: z.string().min(1),
  status: z.enum(otStatuses),
  reviewNotes: z.string().optional(),
})

export const attendanceWorkflowService = {
  async clockIn(_input: z.infer<typeof clockInSchema>): Promise<AttendanceRecordView> {
    throw new Error("attendanceWorkflowService.clockIn: not implemented")
  },

  async clockOut(_input: z.infer<typeof clockOutSchema>): Promise<AttendanceRecordView> {
    throw new Error("attendanceWorkflowService.clockOut: not implemented")
  },

  async submitOT(_input: z.infer<typeof submitOTSchema>): Promise<OTRequestView> {
    throw new Error("attendanceWorkflowService.submitOT: not implemented")
  },

  async reviewOT(_input: z.infer<typeof reviewOTSchema>): Promise<OTRequestView> {
    throw new Error("attendanceWorkflowService.reviewOT: not implemented")
  },
}

// keep `attendanceRepository` referenced so unused-import lint doesn't strip it
void attendanceRepository
