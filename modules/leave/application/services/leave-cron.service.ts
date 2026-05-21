import "server-only"

import { getLeavePrismaClient } from "@/modules/leave/infrastructure/leave-repository"
import {
  carryForwardAmount,
  nextAccruedDays,
  unusedCarriedAtExpiry,
} from "@/modules/leave/domain/accrual"
import type { LeaveAccrualMethod } from "@/modules/leave/domain/models"
import { resolveDefaultEntitledDays } from "./leave-entitlements.service"

/// Year-rollover: for each active employee × non-archived leave type,
/// create next-year's LeaveEntitlement row using:
///   entitledDays = resolveDefaultEntitledDays(employee, type)
///   carriedDays  = carryForwardAmount(thisYear's row) if carryForward
/// Idempotent — re-running for the same year is a no-op (upsert).
export async function runYearRollover(targetYear: number): Promise<{
  ok: true
  created: number
  updated: number
  skipped: number
}> {
  const prisma = getLeavePrismaClient()

  const types = await prisma.leaveType.findMany({
    where: { archivedAt: null },
  })
  const employees = await prisma.employeeProfile.findMany({
    select: { id: true, policyId: true, user: { select: { organizationId: true } } },
  })
  const prevYear = targetYear - 1

  let created = 0
  let updated = 0
  let skipped = 0

  for (const t of types) {
    // Employees in the same org as this leave type.
    const eligible = employees.filter((e) => e.user.organizationId === t.organizationId)
    for (const emp of eligible) {
      const prev = await prisma.leaveEntitlement.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: emp.id,
            leaveTypeId: t.id,
            year: prevYear,
          },
        },
      })

      const entitledDays = await resolveDefaultEntitledDays(emp.id, t.id)
      let carriedDays = 0
      let carriedExpiresAt: Date | null = null
      if (t.carryForward && prev) {
        carriedDays = carryForwardAmount({
          accrualMethod: t.accrualMethod as LeaveAccrualMethod,
          entitledDays: prev.entitledDays,
          accruedDays: prev.accruedDays,
          carriedDays: prev.carriedExpired ? 0 : prev.carriedDays,
          usedDays: prev.usedDays,
          maxCarryForwardDays: t.maxCarryForwardDays,
        })
        if (carriedDays > 0 && t.carryExpiryMonth) {
          // Expires at the start of the configured month in targetYear.
          carriedExpiresAt = new Date(Date.UTC(targetYear, t.carryExpiryMonth - 1, 1))
        }
      }

      const accruedDays = t.accrualMethod === "PRO_RATED" ? 0 : entitledDays

      const existing = await prisma.leaveEntitlement.findUnique({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: emp.id,
            leaveTypeId: t.id,
            year: targetYear,
          },
        },
      })
      if (existing) {
        skipped += 1
        continue
      }
      try {
        await prisma.leaveEntitlement.create({
          data: {
            employeeId: emp.id,
            leaveTypeId: t.id,
            year: targetYear,
            entitledDays,
            accruedDays,
            carriedDays,
            carriedExpiresAt,
          },
        })
        created += 1
      } catch (err) {
        // Concurrent rollover already inserted this row — treat as skipped.
        if (
          typeof err === "object" &&
          err !== null &&
          (err as { code?: string }).code === "P2002"
        ) {
          skipped += 1
          continue
        }
        throw err
      }
    }
  }

  return { ok: true, created, updated, skipped }
}

/// Monthly job: accrue 1/12 of entitledDays for PRO_RATED entitlements,
/// and sweep expired carry-forward.
export async function runMonthlyAccrual(now: Date = new Date()): Promise<{
  ok: true
  accruedCount: number
  expiredCount: number
}> {
  const prisma = getLeavePrismaClient()

  // Pick the year in Asia/Kuala_Lumpur, not UTC — so a midnight-MYT firing
  // on Jan 1 accrues into the new year (UTC clock still shows Dec 31 at
  // that instant).
  const year = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
    }).format(now),
  )

  // 1) Accrue PRO_RATED entitlements.
  const proRated = await prisma.leaveEntitlement.findMany({
    where: {
      year,
      leaveType: { accrualMethod: "PRO_RATED", archivedAt: null },
    },
    include: { leaveType: true },
  })
  let accruedCount = 0
  for (const e of proRated) {
    const next = nextAccruedDays(e.entitledDays, e.accruedDays)
    if (next === e.accruedDays) continue
    await prisma.leaveEntitlement.update({
      where: { id: e.id },
      data: { accruedDays: next },
    })
    accruedCount += 1
  }

  // 2) Expire carry-forward whose expiry is in the past.
  const expiring = await prisma.leaveEntitlement.findMany({
    where: {
      carriedExpired: false,
      carriedExpiresAt: { lte: now },
      carriedDays: { gt: 0 },
    },
    include: { leaveType: true },
  })
  let expiredCount = 0
  for (const e of expiring) {
    const unused = unusedCarriedAtExpiry({
      accrualMethod: e.leaveType.accrualMethod as LeaveAccrualMethod,
      entitledDays: e.entitledDays,
      accruedDays: e.accruedDays,
      carriedDays: e.carriedDays,
      usedDays: e.usedDays,
    })
    await prisma.leaveEntitlement.update({
      where: { id: e.id },
      data: {
        carriedDays: Math.max(0, e.carriedDays - unused),
        carriedExpired: true,
      },
    })
    expiredCount += 1
  }

  return { ok: true, accruedCount, expiredCount }
}
