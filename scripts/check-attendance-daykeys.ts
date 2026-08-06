/**
 * Integrity check: every AttendanceRecord.date must be the UTC-midnight of the
 * *org-local* calendar date on which its session actually started.
 *
 * Why this exists: clock-in originally derived the day-key with
 * `setUTCHours(0,0,0,0)`. Malaysia is UTC+8, so any clock-in between 00:00 and
 * 08:00 MYT is still the previous day in UTC and got filed one day early —
 * which is most of the workforce's normal arrival window. Fixed in bdcdfc5 by
 * routing every day-key through `startOfLocalDay(now, orgTz)`.
 *
 * `modules/attendance/domain/__tests__/timezone.test.ts` guards the domain
 * function. This script guards the *data*: it catches a regression introduced
 * by some NEW write path that bypasses `startOfLocalDay` altogether, which no
 * unit test would notice. Read-only — it never writes.
 *
 * Usage:
 *   npx tsx scripts/check-attendance-daykeys.ts            # last 30 days
 *   npx tsx scripts/check-attendance-daykeys.ts --days 90
 *   npx tsx scripts/check-attendance-daykeys.ts --all
 *
 * Exit code 1 when drift is found, so it can be wired into a cron/alert.
 */

import "dotenv/config"

import { PrismaMariaDb } from "@prisma/adapter-mariadb"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"
import {
  DEFAULT_TIMEZONE,
  startOfLocalDay,
} from "../modules/attendance/domain/timezone"

const cfg = getDatabaseConnectionConfig()
if (!cfg) throw new Error("DATABASE_URL not configured")
const adapter = new PrismaMariaDb(cfg)
const prisma = new PrismaClient({ adapter } as never)

function parseDays(): number | null {
  if (process.argv.includes("--all")) return null
  const i = process.argv.indexOf("--days")
  if (i !== -1 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1])
    if (Number.isFinite(n) && n > 0) return n
  }
  return 30
}

async function main() {
  const days = parseDays()
  const since = days === null ? null : new Date(Date.now() - days * 86_400_000)

  console.log(
    `[daykey-check] scanning ${days === null ? "ALL history" : `the last ${days} days`}…`,
  )

  const sessions = await prisma.attendanceSession.findMany({
    where: since ? { startedAt: { gte: since } } : {},
    select: {
      id: true,
      startedAt: true,
      attendanceRecord: {
        select: {
          id: true,
          date: true,
          employeeId: true,
          employee: {
            select: {
              name: true,
              organization: { select: { name: true, timezone: true } },
            },
          },
        },
      },
    },
    orderBy: { startedAt: "desc" },
  })

  const bad: Array<{
    org: string
    employee: string
    filed: string
    correct: string
    startedAtLocal: string
  }> = []

  for (const s of sessions) {
    const rec = s.attendanceRecord
    if (!rec) continue
    const tz = rec.employee?.organization?.timezone || DEFAULT_TIMEZONE
    const correct = startOfLocalDay(s.startedAt, tz)
    if (correct.getTime() === rec.date.getTime()) continue

    bad.push({
      org: rec.employee?.organization?.name ?? "(no org)",
      employee: rec.employee?.name ?? rec.employeeId,
      filed: rec.date.toISOString().slice(0, 10),
      correct: correct.toISOString().slice(0, 10),
      startedAtLocal: new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        dateStyle: "short",
        timeStyle: "medium",
        hour12: false,
      }).format(s.startedAt),
    })
  }

  console.log(`[daykey-check] inspected ${sessions.length} sessions`)

  if (bad.length === 0) {
    console.log("[daykey-check] OK — every day-key matches its org-local start date.")
    return
  }

  console.error(`\n[daykey-check] ${bad.length} MIS-FILED session(s):\n`)
  console.table(bad)
  console.error(
    "\nA record filed under the wrong day skews that employee's attendance " +
      "history, hours totals and any payroll derived from them.\n" +
      "If these are new, look for an AttendanceRecord create/upsert that sets " +
      "`date` without going through startOfLocalDay(now, orgTz).",
  )
  process.exitCode = 1
}

main()
  .catch((err) => {
    console.error("[daykey-check] failed:", err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
