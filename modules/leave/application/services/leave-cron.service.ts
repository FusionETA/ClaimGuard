import "server-only"

import { getLeavePrismaClient } from "@/modules/leave/infrastructure/leave-repository"
import {
  carryForwardAmount,
  nextAccruedDays,
  unusedCarriedAtExpiry,
} from "@/modules/leave/domain/accrual"
import type { LeaveAccrualMethod } from "@/modules/leave/domain/models"
import {
  resolveAccrualMethodFromLayers,
  resolveDefaultEntitledDays,
} from "./leave-entitlements.service"

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

  // Pre-load per-policy method overrides for the eligible orgs so we
  // can resolve the effective accrual method per (employee × type)
  // without N+1 queries. Keyed as `${policyId}:${leaveTypeId}`.
  const policyMethodOverrides = await prisma.policyLeaveEntitlement.findMany({
    where: { accrualMethod: { not: null } },
    select: { policyId: true, leaveTypeId: true, accrualMethod: true },
  })
  const policyMethodIndex = new Map<string, LeaveAccrualMethod>()
  for (const row of policyMethodOverrides) {
    if (row.accrualMethod) {
      policyMethodIndex.set(
        `${row.policyId}:${row.leaveTypeId}`,
        row.accrualMethod as LeaveAccrualMethod,
      )
    }
  }

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

      // Effective method for the carry-forward computation: walk the
      // employee row (prev year's `accrualMethod`) → policy override →
      // type. The new row's own `accrualMethod` mirrors the prev row's
      // so per-employee overrides survive the rollover.
      const policyMethod = emp.policyId
        ? (policyMethodIndex.get(`${emp.policyId}:${t.id}`) ?? null)
        : null
      const employeeMethod =
        (prev?.accrualMethod ?? null) as LeaveAccrualMethod | null
      const effectiveMethod = resolveAccrualMethodFromLayers({
        employeeMethod,
        policyMethod,
        typeMethod: t.accrualMethod as LeaveAccrualMethod,
      })

      let carriedDays = 0
      let carriedExpiresAt: Date | null = null
      if (t.carryForward && prev) {
        carriedDays = carryForwardAmount({
          accrualMethod: effectiveMethod,
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

      const accruedDays = effectiveMethod === "PRO_RATED" ? 0 : entitledDays

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
            // Propagate the previous year's employee-layer override
            // onto the new row so explicit per-employee customisations
            // survive the rollover.
            accrualMethod: employeeMethod,
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

  // Pre-load per-policy method overrides so we resolve the effective
  // accrual method per row without N+1 queries.
  const policyMethodOverrides = await prisma.policyLeaveEntitlement.findMany({
    where: { accrualMethod: { not: null } },
    select: { policyId: true, leaveTypeId: true, accrualMethod: true },
  })
  const policyMethodIndex = new Map<string, LeaveAccrualMethod>()
  for (const row of policyMethodOverrides) {
    if (row.accrualMethod) {
      policyMethodIndex.set(
        `${row.policyId}:${row.leaveTypeId}`,
        row.accrualMethod as LeaveAccrualMethod,
      )
    }
  }

  // 1) Accrue rows whose EFFECTIVE method is PRO_RATED. We can no
  // longer pre-filter on `leaveType.accrualMethod` because per-policy
  // and per-employee overrides may flip the method either way. Fetch
  // every active entitlement and resolve per row.
  const all = await prisma.leaveEntitlement.findMany({
    where: { year, leaveType: { archivedAt: null } },
    include: {
      leaveType: { select: { accrualMethod: true } },
      employee: { select: { policyId: true } },
    },
  })
  let accruedCount = 0
  for (const e of all) {
    const policyMethod = e.employee.policyId
      ? (policyMethodIndex.get(`${e.employee.policyId}:${e.leaveTypeId}`) ?? null)
      : null
    const effectiveMethod = resolveAccrualMethodFromLayers({
      employeeMethod: (e.accrualMethod ?? null) as LeaveAccrualMethod | null,
      policyMethod,
      typeMethod: e.leaveType.accrualMethod as LeaveAccrualMethod,
    })
    if (effectiveMethod !== "PRO_RATED") continue
    const next = nextAccruedDays(e.entitledDays, e.accruedDays)
    if (next === e.accruedDays) continue
    await prisma.leaveEntitlement.update({
      where: { id: e.id },
      data: { accruedDays: next },
    })
    accruedCount += 1
  }

  // 2) Expire carry-forward whose expiry is in the past. Effective
  // method matters here too — `unusedCarriedAtExpiry` returns different
  // results for LUMP_SUM vs PRO_RATED.
  const expiring = await prisma.leaveEntitlement.findMany({
    where: {
      carriedExpired: false,
      carriedExpiresAt: { lte: now },
      carriedDays: { gt: 0 },
    },
    include: {
      leaveType: { select: { accrualMethod: true } },
      employee: { select: { policyId: true } },
    },
  })
  let expiredCount = 0
  for (const e of expiring) {
    const policyMethod = e.employee.policyId
      ? (policyMethodIndex.get(`${e.employee.policyId}:${e.leaveTypeId}`) ?? null)
      : null
    const effectiveMethod = resolveAccrualMethodFromLayers({
      employeeMethod: (e.accrualMethod ?? null) as LeaveAccrualMethod | null,
      policyMethod,
      typeMethod: e.leaveType.accrualMethod as LeaveAccrualMethod,
    })
    const unused = unusedCarriedAtExpiry({
      accrualMethod: effectiveMethod,
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
