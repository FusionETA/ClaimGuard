import "server-only"

import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"
import {
  isAnnualCode,
  type LeaveAccrualMethod,
  type LeaveTypeView,
} from "@/modules/leave/domain/models"

export type LeaveTypeInput = {
  code: string
  name: string
  paid: boolean
  accrualMethod: LeaveAccrualMethod
  defaultDays: number
  carryForward: boolean
  carryExpiryMonth: number | null
  maxCarryForwardDays: number | null
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export function validateLeaveTypeInput(input: LeaveTypeInput): { ok: true } | { ok: false; error: string } {
  if (!input.code.trim()) return { ok: false, error: "Code is required" }
  if (!input.name.trim()) return { ok: false, error: "Name is required" }

  const isAnnual = isAnnualCode(input.code)

  if (input.accrualMethod === "PRO_RATED" && !isAnnual) {
    return { ok: false, error: "Pro-rated accrual is only allowed for ANNUAL leave" }
  }
  if (input.carryForward && !isAnnual) {
    return { ok: false, error: "Carry-forward is only allowed for ANNUAL leave" }
  }
  if (input.carryForward) {
    if (input.carryExpiryMonth == null || input.carryExpiryMonth < 1 || input.carryExpiryMonth > 12) {
      return { ok: false, error: "Carry-forward requires an expiry month (1-12)" }
    }
  }
  // Unpaid leave defaults are ignored at accrual time. We accept the value
  // but clamp it to 0 so the data stays consistent.
  if (!input.paid && input.defaultDays !== 0) {
    return { ok: false, error: "Unpaid leave cannot have entitlement days" }
  }
  if (input.defaultDays < 0) {
    return { ok: false, error: "Default days cannot be negative" }
  }
  if (input.maxCarryForwardDays !== null && input.maxCarryForwardDays < 0) {
    return { ok: false, error: "Max carry-forward days cannot be negative" }
  }
  return { ok: true }
}

export async function createLeaveType(
  orgId: string,
  input: LeaveTypeInput,
): Promise<Result<LeaveTypeView>> {
  const v = validateLeaveTypeInput(input)
  if (!v.ok) return v
  try {
    const view = await leaveRepository.createType(orgId, {
      ...input,
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
    })
    return { ok: true, value: view }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/Unique constraint/i.test(msg)) {
      return { ok: false, error: "A leave type with this code already exists" }
    }
    return { ok: false, error: msg }
  }
}

export async function updateLeaveType(
  orgId: string,
  id: string,
  input: LeaveTypeInput,
): Promise<Result<LeaveTypeView>> {
  const v = validateLeaveTypeInput(input)
  if (!v.ok) return v
  const view = await leaveRepository.updateType(orgId, id, {
    name: input.name.trim(),
    paid: input.paid,
    accrualMethod: input.accrualMethod,
    defaultDays: input.paid ? input.defaultDays : 0,
    carryForward: input.carryForward,
    carryExpiryMonth: input.carryForward ? input.carryExpiryMonth : null,
    maxCarryForwardDays: input.maxCarryForwardDays,
  })
  return { ok: true, value: view }
}

export async function archiveLeaveType(
  orgId: string,
  id: string,
): Promise<Result<LeaveTypeView>> {
  const view = await leaveRepository.updateType(orgId, id, { archivedAt: new Date() })
  return { ok: true, value: view }
}

export async function unarchiveLeaveType(
  orgId: string,
  id: string,
): Promise<Result<LeaveTypeView>> {
  const view = await leaveRepository.updateType(orgId, id, { archivedAt: null })
  return { ok: true, value: view }
}

export async function listLeaveTypes(orgId: string, includeArchived = false) {
  return leaveRepository.listTypes(orgId, { includeArchived })
}
