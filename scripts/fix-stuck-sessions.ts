/**
 * One-off: close any AttendanceSessions that have endedAt=null but belong to
 * records from a previous day. Also stamps timeOut + status on the parent
 * AttendanceRecord so history doesn't show "(running)".
 *
 * Usage: npx tsx scripts/fix-stuck-sessions.ts [--apply]
 */

import { PrismaMariaDb } from "@prisma/adapter-mariadb"
import { getDatabaseConnectionConfig } from "../lib/database-config"
import { PrismaClient } from "../generated/prisma/client"

const cfg = getDatabaseConnectionConfig()
if (!cfg) throw new Error("DATABASE_URL not configured")
const adapter = new PrismaMariaDb(cfg)
const prisma = new PrismaClient({ adapter } as never)

async function main() {
  const apply = process.argv.includes("--apply")
  const now = new Date()
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)

  const stuckRecords = await prisma.attendanceRecord.findMany({
    where: {
      date: { lt: today },
      sessions: { some: { endedAt: null } },
    },
    select: {
      id: true,
      employeeId: true,
      date: true,
      timeOut: true,
      status: true,
      sessions: {
        where: { endedAt: null },
        select: { id: true, startedAt: true },
      },
    },
  })

  if (stuckRecords.length === 0) {
    console.log("No stuck sessions found.")
    return
  }

  console.log(`Found ${stuckRecords.length} record(s) with open sessions from previous days:`)
  for (const r of stuckRecords) {
    console.log(`  ${r.date.toISOString().slice(0, 10)}  employeeId=${r.employeeId}  status=${r.status}  openSessions=${r.sessions.length}`)
  }

  if (!apply) {
    console.log("\n[Dry run] Run with --apply to fix.")
    return
  }

  for (const r of stuckRecords) {
    await prisma.attendanceSession.updateMany({
      where: { attendanceRecordId: r.id, endedAt: null },
      data: { endedAt: now, durationMin: 0 },
    })
    await prisma.attendanceRecord.update({
      where: { id: r.id },
      data: { timeOut: now, status: "CLOCKED_OUT" },
    })
    console.log(`  Fixed record ${r.id} (${r.date.toISOString().slice(0, 10)})`)
  }

  console.log("\nDone.")
}

main().catch(console.error).finally(() => prisma.$disconnect())
