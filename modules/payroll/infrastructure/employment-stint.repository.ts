import "server-only"

import { getPrismaClient } from "@/lib/prisma"

/**
 * Repository for `EmploymentStint` — the tenure log for an
 * `EmployeeProfile`. See the model docblock in schema.prisma for the
 * full semantic explanation.
 *
 * Layered-architecture rule: this file owns every Prisma call against
 * the stint table. Services call these methods; nobody else touches
 * `prisma.employmentStint.*` directly.
 */

export type EmploymentStintRow = {
  id: string
  employeeProfileId: string
  /// ISO yyyy-mm-dd (DATE column — no time component to carry).
  joinDate: string
  /// ISO yyyy-mm-dd or null (null = currently open).
  leaveDate: string | null
  startReason: string | null
  endReason: string | null
  openedByTransferId: string | null
  closedByTransferId: string | null
  createdAt: string
  updatedAt: string
}

export const employmentStintRepository = {
  /**
   * Return every stint for the given profile, oldest first. Empty
   * array when the profile is a legacy one that hasn't been
   * backfilled yet — callers can fall back to
   * `PayrollProfile.joinDate` / `leaveDate` in that case.
   */
  async listForProfile(
    employeeProfileId: string,
  ): Promise<EmploymentStintRow[]> {
    const prisma = getPrismaClient()
    if (!prisma) return []
    const rows = await prisma.employmentStint.findMany({
      where: { employeeProfileId },
      orderBy: { joinDate: "asc" },
    })
    return rows.map(mapRow)
  },

  /**
   * Return the single OPEN stint for the profile, if any. There is
   * at most one — the service layer enforces the invariant. Used by
   * the archive + transfer close paths to know which row to touch.
   */
  async findOpenForProfile(
    employeeProfileId: string,
  ): Promise<EmploymentStintRow | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null
    const row = await prisma.employmentStint.findFirst({
      where: { employeeProfileId, leaveDate: null },
      orderBy: { joinDate: "desc" },
    })
    return row ? mapRow(row) : null
  },

  /**
   * Insert a fresh stint row. Callers are expected to have already
   * confirmed no other open stint exists (or to close it first —
   * `closeOpenStint` below). Accepts an optional Prisma tx client so
   * this can participate in a bigger transaction (transfer, hire).
   */
  async createStint(
    input: {
      employeeProfileId: string
      joinDate: Date
      startReason?: string | null
      openedByTransferId?: string | null
    },
    tx?: unknown,
  ): Promise<EmploymentStintRow> {
    const client = (tx as ReturnType<typeof getPrismaClient>) ?? getPrismaClient()
    if (!client) throw new Error("Database is not configured.")
    const row = await client.employmentStint.create({
      data: {
        employeeProfileId: input.employeeProfileId,
        joinDate: input.joinDate,
        startReason: input.startReason ?? null,
        openedByTransferId: input.openedByTransferId ?? null,
      },
    })
    return mapRow(row)
  },

  /**
   * Close the currently-open stint for the profile. No-op when there
   * is no open stint (e.g. profile was archived before stints
   * existed and hasn't been backfilled). Returns the closed row or
   * null.
   */
  async closeOpenStint(
    input: {
      employeeProfileId: string
      leaveDate: Date
      endReason?: string | null
      closedByTransferId?: string | null
    },
    tx?: unknown,
  ): Promise<EmploymentStintRow | null> {
    const client = (tx as ReturnType<typeof getPrismaClient>) ?? getPrismaClient()
    if (!client) throw new Error("Database is not configured.")
    const open = await client.employmentStint.findFirst({
      where: {
        employeeProfileId: input.employeeProfileId,
        leaveDate: null,
      },
      orderBy: { joinDate: "desc" },
    })
    if (!open) return null
    const row = await client.employmentStint.update({
      where: { id: open.id },
      data: {
        leaveDate: input.leaveDate,
        endReason: input.endReason ?? null,
        closedByTransferId: input.closedByTransferId ?? null,
      },
    })
    return mapRow(row)
  },

  /**
   * Ensure the profile has at least one stint row. Used by the
   * backfill script AND — defensively — anywhere we're about to
   * close a stint but the profile might be legacy (no rows yet).
   * If a row already exists, returns it unchanged. Otherwise seeds
   * one from the supplied dates.
   *
   * Idempotent — safe to call on every request if needed.
   */
  async ensureStint(
    input: {
      employeeProfileId: string
      joinDate: Date
      leaveDate: Date | null
      startReason?: string | null
      endReason?: string | null
    },
    tx?: unknown,
  ): Promise<EmploymentStintRow> {
    const client = (tx as ReturnType<typeof getPrismaClient>) ?? getPrismaClient()
    if (!client) throw new Error("Database is not configured.")
    const existing = await client.employmentStint.findFirst({
      where: { employeeProfileId: input.employeeProfileId },
      orderBy: { joinDate: "asc" },
    })
    if (existing) return mapRow(existing)
    const row = await client.employmentStint.create({
      data: {
        employeeProfileId: input.employeeProfileId,
        joinDate: input.joinDate,
        leaveDate: input.leaveDate,
        startReason: input.startReason ?? null,
        endReason: input.endReason ?? null,
      },
    })
    return mapRow(row)
  },

  /**
   * Return the set of employee-profile ids that have any stint
   * overlapping the given period window. Used by the payroll run
   * engine's period filter — an employee gets included in a run
   * when at least one of their stints intersects that month.
   *
   * Overlap semantics (inclusive both ends):
   *   stint.joinDate <= endOfMonth
   *   AND (stint.leaveDate IS NULL OR stint.leaveDate >= startOfMonth)
   *
   * Callers scope by org via the accompanying `employeeProfileId
   * IN (…)` predicate on the outer query — this repo doesn't know
   * about orgs.
   */
  async listProfileIdsActiveInPeriod(input: {
    employeeProfileIds: string[]
    startOfMonth: Date
    endOfMonth: Date
  }): Promise<Set<string>> {
    const prisma = getPrismaClient()
    if (!prisma) return new Set()
    if (input.employeeProfileIds.length === 0) return new Set()
    const rows = await prisma.employmentStint.findMany({
      where: {
        employeeProfileId: { in: input.employeeProfileIds },
        joinDate: { lte: input.endOfMonth },
        OR: [
          { leaveDate: null },
          { leaveDate: { gte: input.startOfMonth } },
        ],
      },
      select: { employeeProfileId: true },
    })
    return new Set(rows.map((r) => r.employeeProfileId))
  },
}

// ─── Internals ─────────────────────────────────────────────────────

function mapRow(row: {
  id: string
  employeeProfileId: string
  joinDate: Date
  leaveDate: Date | null
  startReason: string | null
  endReason: string | null
  openedByTransferId: string | null
  closedByTransferId: string | null
  createdAt: Date
  updatedAt: Date
}): EmploymentStintRow {
  return {
    id: row.id,
    employeeProfileId: row.employeeProfileId,
    joinDate: row.joinDate.toISOString().slice(0, 10),
    leaveDate: row.leaveDate ? row.leaveDate.toISOString().slice(0, 10) : null,
    startReason: row.startReason,
    endReason: row.endReason,
    openedByTransferId: row.openedByTransferId,
    closedByTransferId: row.closedByTransferId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
