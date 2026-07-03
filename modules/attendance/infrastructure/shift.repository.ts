import "server-only"

import { getPrismaClient } from "@/lib/prisma"
import type { ShiftView } from "@/modules/attendance/domain/models"

/**
 * Prisma access for the `Shift` model + the "exactly one default per
 * project" invariant. Called from `admin-attendance.service.ts`; the
 * page + action layers should NEVER hit `prisma.shift.*` directly.
 *
 * All mutating calls run inside a `$transaction` where the invariant
 * needs enforcing (create-as-default, set-default). Reads are cheap
 * single-table queries with the project name joined for display.
 */

type PrismaShiftRow = {
  id: string
  organizationId: string
  projectId: string
  name: string
  startTime: string
  endTime: string
  workingDays: string | null
  lunchBreakMin: number
  isDefault: boolean
  createdAt: Date
  updatedAt: Date
  project: { id: string; name: string }
  _count: { memberships: number }
}

function mapShift(row: PrismaShiftRow): ShiftView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    projectName: row.project.name,
    name: row.name,
    startTime: row.startTime,
    endTime: row.endTime,
    workingDays: row.workingDays,
    lunchBreakMin: row.lunchBreakMin,
    isDefault: row.isDefault,
    assignedMemberCount: row._count.memberships,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const shiftInclude = {
  project: { select: { id: true, name: true } },
  _count: { select: { memberships: true } },
} as const

export const shiftRepository = {
  /**
   * All shifts across the org, joined with their project name and
   * live assigned-member count. Sorted by project → default-first →
   * name so the admin sees the default shift at the top of each
   * project's group.
   */
  async listForOrganization(organizationId: string): Promise<ShiftView[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.shift.findMany({
      where: { organizationId },
      include: shiftInclude,
      orderBy: [
        { project: { name: "asc" } },
        { isDefault: "desc" },
        { name: "asc" },
      ],
    })
    return rows.map(mapShift)
  },

  /**
   * Create a shift. When `isDefault` is true, atomically clear any
   * existing default within the same project first — enforces the
   * "at most one default per project" invariant even under concurrent
   * writes (both branches run inside the same transaction).
   */
  async create(input: {
    organizationId: string
    projectId: string
    name: string
    startTime: string
    endTime: string
    workingDays: string | null
    lunchBreakMin: number
    isDefault: boolean
  }): Promise<ShiftView> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const row = await prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.shift.updateMany({
          where: { projectId: input.projectId, isDefault: true },
          data: { isDefault: false },
        })
      }
      return tx.shift.create({
        data: {
          organizationId: input.organizationId,
          projectId: input.projectId,
          name: input.name,
          startTime: input.startTime,
          endTime: input.endTime,
          workingDays: input.workingDays,
          lunchBreakMin: input.lunchBreakMin,
          isDefault: input.isDefault,
        },
        include: shiftInclude,
      })
    })
    return mapShift(row)
  },

  /**
   * Update a shift. When `isDefault: true` is set, atomically clear
   * any other default in the same project first. `undefined` fields
   * are left untouched (partial-update semantics).
   */
  async update(input: {
    id: string
    organizationId: string
    name?: string
    startTime?: string
    endTime?: string
    workingDays?: string | null
    lunchBreakMin?: number
    isDefault?: boolean
  }): Promise<ShiftView> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    // Look up projectId first — need it for the atomic default swap
    // AND to scope-check the shift belongs to the admin's org.
    const existing = await prisma.shift.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { projectId: true },
    })
    if (!existing) throw new Error("Shift not found in this organisation.")

    const row = await prisma.$transaction(async (tx) => {
      if (input.isDefault === true) {
        await tx.shift.updateMany({
          where: {
            projectId: existing.projectId,
            isDefault: true,
            id: { not: input.id },
          },
          data: { isDefault: false },
        })
      }
      return tx.shift.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.startTime !== undefined
            ? { startTime: input.startTime }
            : {}),
          ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
          ...(input.workingDays !== undefined
            ? { workingDays: input.workingDays }
            : {}),
          ...(input.lunchBreakMin !== undefined
            ? { lunchBreakMin: input.lunchBreakMin }
            : {}),
          ...(input.isDefault !== undefined
            ? { isDefault: input.isDefault }
            : {}),
        },
        include: shiftInclude,
      })
    })
    return mapShift(row)
  },

  /**
   * Delete a shift. Refuses if any `EmployeeTeamMembership.shiftId`
   * still references it — reassign or clear those first. Also blocks
   * deleting the last (default) shift for a project that still has
   * members. Callers should surface the returned error code so the
   * UI can render a helpful message.
   */
  async delete(input: {
    id: string
    organizationId: string
  }): Promise<
    | { ok: true }
    | {
        ok: false
        code: "IN_USE"
        assignedMemberCount: number
      }
    | { ok: false; code: "NOT_FOUND" }
  > {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const target = await prisma.shift.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      include: { _count: { select: { memberships: true } } },
    })
    if (!target) return { ok: false, code: "NOT_FOUND" }

    if (target._count.memberships > 0) {
      return {
        ok: false,
        code: "IN_USE",
        assignedMemberCount: target._count.memberships,
      }
    }

    await prisma.shift.delete({ where: { id: input.id } })
    return { ok: true }
  },

  /**
   * Set a shift as the default for its project. Wraps the two-step
   * "clear old default + set new default" in a transaction to keep
   * the invariant under concurrent admins clicking Default on
   * different shifts.
   */
  async setDefault(input: {
    id: string
    organizationId: string
  }): Promise<ShiftView> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    const target = await prisma.shift.findFirst({
      where: { id: input.id, organizationId: input.organizationId },
      select: { projectId: true },
    })
    if (!target) throw new Error("Shift not found in this organisation.")

    const row = await prisma.$transaction(async (tx) => {
      await tx.shift.updateMany({
        where: {
          projectId: target.projectId,
          isDefault: true,
          id: { not: input.id },
        },
        data: { isDefault: false },
      })
      return tx.shift.update({
        where: { id: input.id },
        data: { isDefault: true },
        include: shiftInclude,
      })
    })
    return mapShift(row)
  },
}
