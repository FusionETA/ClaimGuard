/**
 * One-off backfill: for every AttendanceRecord that has a timeIn but no
 * AttendanceSession yet, create one AttendanceSession copying all per-event
 * data, and re-link existing BreakSessions to that session.
 *
 * Idempotent: records that already have at least one session are skipped.
 *
 * Run once after `npm run db:push`:
 *   npx tsx prisma/backfill-attendance-sessions.ts
 */

import { getPrismaClient } from "../lib/prisma"

async function main() {
  const prisma = getPrismaClient()
  if (!prisma) {
    console.error("Database not configured — set DATABASE_URL")
    process.exit(1)
  }

  const records = await prisma.attendanceRecord.findMany({
    where: {
      timeIn: { not: null },
      sessions: { none: {} },
    },
    select: {
      id: true,
      timeIn: true,
      timeOut: true,
      durationMin: true,
      status: true,
      clockInLat: true,
      clockInLng: true,
      clockInDistanceMeters: true,
      clockOutLat: true,
      clockOutLng: true,
      clockOutDistanceMeters: true,
      notes: true,
      project: true,
      projectId: true,
      xeroSelfieFileId: true,
      selfieUploadedAt: true,
      breaks: {
        select: { id: true },
      },
    },
  })

  console.log(`Found ${records.length} AttendanceRecord(s) to backfill`)

  let created = 0
  let skipped = 0

  for (const record of records) {
    if (!record.timeIn) {
      skipped++
      continue
    }

    const sessionStatus =
      record.status === "CLOCKED_OUT" ||
      record.status === "ON_TIME" ||
      record.status === "LATE"
        ? record.status
        : record.timeOut
          ? "CLOCKED_OUT"
          : "ON_TIME"

    const session = await prisma.attendanceSession.create({
      data: {
        attendanceRecordId: record.id,
        startedAt: record.timeIn,
        endedAt: record.timeOut ?? null,
        durationMin: record.durationMin ?? null,
        status: sessionStatus as "ON_TIME" | "LATE" | "CLOCKED_OUT",
        clockInLat: record.clockInLat ?? null,
        clockInLng: record.clockInLng ?? null,
        clockInDistanceMeters: record.clockInDistanceMeters ?? null,
        clockOutLat: record.clockOutLat ?? null,
        clockOutLng: record.clockOutLng ?? null,
        clockOutDistanceMeters: record.clockOutDistanceMeters ?? null,
        project: record.project ?? null,
        projectId: record.projectId ?? null,
        xeroSelfieFileId: record.xeroSelfieFileId ?? null,
        selfieUploadedAt: record.selfieUploadedAt ?? null,
      },
    })

    // Re-link existing BreakSessions to this session.
    if (record.breaks.length > 0) {
      await prisma.breakSession.updateMany({
        where: { id: { in: record.breaks.map((b) => b.id) } },
        data: { attendanceSessionId: session.id },
      })
    }

    created++
    if (created % 100 === 0) {
      console.log(`  … ${created} sessions created`)
    }
  }

  console.log(`Done. Created ${created} session(s), skipped ${skipped} record(s) with no timeIn.`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
