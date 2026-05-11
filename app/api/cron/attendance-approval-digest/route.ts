import { NextRequest, NextResponse } from "next/server"

import { getPrismaClient } from "@/lib/prisma"
import { getRedis, key } from "@/lib/redis"
import { sendPushToUser } from "@/lib/web-push"
import { attendanceRepository } from "@/modules/attendance/infrastructure/attendance.repository"
import type { ApprovalRequestView } from "@/modules/attendance/domain/models"

/**
 * POST /api/cron/attendance-approval-digest
 *
 * Periodic digest reminder for supervisors with pending attendance /
 * OT approvals. Called by an external cron (cPanel) every 30 minutes.
 *
 * Business-hours handling is **per organization**, not global. Each
 * org has its own `workingHoursStart` / `workingHoursEnd` + `timezone`
 * configured in admin settings; we respect those individually. An org
 * with no pending approvals is skipped entirely; an org outside its
 * configured working window is skipped with a logged reason.
 *
 * Decision rules per reviewer (within an in-hours org):
 *   1. First time we see them with pending items     → PUSH
 *   2. Pending count went UP since last check        → PUSH
 *   3. Count is same but no push in 2 hours          → PUSH (gentle reminder)
 *   4. Count went DOWN                               → SKIP (working through it)
 *   5. Count is same and pushed recently             → SKIP
 *
 * Auth: header `Authorization: Bearer <CRON_SECRET>`.
 */

const REMINDER_INTERVAL_MS = 2 * 60 * 60 * 1000 // 2 hours
const STATE_TTL_SECONDS = 24 * 60 * 60 // 24h — auto-clear digest state if a reviewer goes quiet

type DigestState = {
  /// Pending count we last observed for this reviewer.
  count: number
  /// Oldest pending item's event time at last observation (epoch ms).
  oldestAtMs: number
  /// When we last pushed a notification to this reviewer (epoch ms).
  lastPushedAtMs: number
}

export async function POST(request: NextRequest) {
  // -------- auth -----------------------------------------------------------
  const expected = process.env.CRON_SECRET?.trim()
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured on server" },
      { status: 500 },
    )
  }
  const auth = request.headers.get("authorization") ?? ""
  const match = auth.match(/^Bearer\s+(.+)$/i)
  if (!match || match[1].trim() !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 })
  }

  const prisma = getPrismaClient()
  if (!prisma) {
    return NextResponse.json({ ok: false, error: "database not configured" })
  }

  // -------- query pending approvals (direct DB; cron needs accuracy) ------
  let pending: ApprovalRequestView[]
  try {
    pending = await attendanceRepository.getAllPendingApprovals()
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: "failed to query pending approvals",
      details: err instanceof Error ? err.message : String(err),
    })
  }

  if (pending.length === 0) {
    return NextResponse.json({
      ok: true,
      pendingTotal: 0,
      orgsProcessed: 0,
      pushedCount: 0,
    })
  }

  // -------- resolve each approval's organisation ---------------------------
  // The view doesn't carry organizationId, so batch-look-up via employee
  // → user.organizationId. Reviewers and employees are in the same org
  // (approval chains are within-org).
  const employeeIds = Array.from(new Set(pending.map((p) => p.employeeId)))
  const employees = await prisma.user.findMany({
    where: { id: { in: employeeIds } },
    select: { id: true, organizationId: true },
  })
  const employeeOrgMap = new Map(
    employees
      .filter((e) => e.organizationId)
      .map((e) => [e.id, e.organizationId as string]),
  )

  // Group approvals by org.
  const approvalsByOrg = new Map<string, ApprovalRequestView[]>()
  for (const approval of pending) {
    const orgId = employeeOrgMap.get(approval.employeeId)
    if (!orgId) continue // employee not found / no org — skip
    const arr = approvalsByOrg.get(orgId) ?? []
    arr.push(approval)
    approvalsByOrg.set(orgId, arr)
  }

  // -------- iterate orgs, gate on per-org working hours -------------------
  const redis = getRedis()
  const now = Date.now()
  const orgsProcessed: Array<{
    orgId: string
    decision: "in-hours" | "out-of-hours"
    nowInOrgTz?: string
    workingHours?: { start: string; end: string }
    pushedCount?: number
    skippedCount?: number
  }> = []
  const pushed: Array<{
    orgId: string
    reviewerId: string
    count: number
    reason: string
  }> = []
  const skipped: Array<{
    orgId: string
    reviewerId: string
    reason: string
  }> = []

  for (const [orgId, approvals] of approvalsByOrg) {
    const [workingHours, timezone] = await Promise.all([
      attendanceRepository.getWorkingHours(orgId),
      attendanceRepository.getOrgTimezone(orgId),
    ])

    const nowInTz = currentTimeInTimezone(timezone)
    if (!isWithinWorkingHours(nowInTz, workingHours)) {
      orgsProcessed.push({
        orgId,
        decision: "out-of-hours",
        nowInOrgTz: nowInTz,
        workingHours,
      })
      continue
    }

    // Within working hours — group by reviewer and apply digest rules.
    type Group = { reviewerId: string; count: number; oldestAtMs: number }
    const groups = new Map<string, Group>()
    for (const row of approvals) {
      if (!row.reviewerId) continue
      const ms = parseAgeMs(row.eventAt ?? row.date)
      const existing = groups.get(row.reviewerId)
      if (existing) {
        existing.count += 1
        if (ms < existing.oldestAtMs) existing.oldestAtMs = ms
      } else {
        groups.set(row.reviewerId, {
          reviewerId: row.reviewerId,
          count: 1,
          oldestAtMs: ms,
        })
      }
    }

    let orgPushed = 0
    let orgSkipped = 0

    for (const group of groups.values()) {
      const stateKey = key(
        "digest",
        "attendance",
        "reviewer",
        group.reviewerId,
      )
      const prev = await readState(redis, stateKey)

      let shouldPush = false
      let reason = ""

      if (!prev) {
        shouldPush = true
        reason = "first-seen"
      } else if (group.count > prev.count) {
        shouldPush = true
        reason = `count up ${prev.count}→${group.count}`
      } else if (group.count === prev.count) {
        if (now - prev.lastPushedAtMs >= REMINDER_INTERVAL_MS) {
          shouldPush = true
          reason = "2h reminder"
        } else {
          reason = "recently pushed, same count"
        }
      } else {
        reason = `count down ${prev.count}→${group.count}`
      }

      if (shouldPush) {
        const ageMin = Math.max(
          0,
          Math.round((now - group.oldestAtMs) / 60_000),
        )
        const ageLabel = formatAge(ageMin)
        const body =
          group.count === 1
            ? `1 attendance approval waiting. Oldest ${ageLabel} old.`
            : `${group.count} attendance approvals waiting. Oldest ${ageLabel} old.`

        try {
          await sendPushToUser(group.reviewerId, {
            title: "Approvals Waiting",
            body,
            url: "/employee/attendance/approvals",
          })
        } catch {
          // sendPushToUser swallows internally, but belt + suspenders.
        }

        await writeState(redis, stateKey, {
          count: group.count,
          oldestAtMs: group.oldestAtMs,
          lastPushedAtMs: now,
        })
        pushed.push({
          orgId,
          reviewerId: group.reviewerId,
          count: group.count,
          reason,
        })
        orgPushed += 1
      } else {
        // Refresh count/oldestAt so the next comparison is accurate, but
        // DON'T touch lastPushedAt — the 2h reminder clock keeps ticking
        // from the last actual push.
        if (prev) {
          await writeState(redis, stateKey, {
            count: group.count,
            oldestAtMs: group.oldestAtMs,
            lastPushedAtMs: prev.lastPushedAtMs,
          })
        }
        skipped.push({ orgId, reviewerId: group.reviewerId, reason })
        orgSkipped += 1
      }
    }

    orgsProcessed.push({
      orgId,
      decision: "in-hours",
      nowInOrgTz: nowInTz,
      workingHours,
      pushedCount: orgPushed,
      skippedCount: orgSkipped,
    })
  }

  return NextResponse.json({
    ok: true,
    pendingTotal: pending.length,
    orgsProcessed: orgsProcessed.length,
    pushedCount: pushed.length,
    skippedCount: skipped.length,
    orgs: orgsProcessed,
    pushed,
    skipped,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readState(
  redis: ReturnType<typeof getRedis>,
  stateKey: string,
): Promise<DigestState | null> {
  if (!redis) return null
  try {
    const raw = await redis.get(stateKey)
    if (!raw) return null
    return JSON.parse(raw) as DigestState
  } catch {
    return null
  }
}

async function writeState(
  redis: ReturnType<typeof getRedis>,
  stateKey: string,
  state: DigestState,
): Promise<void> {
  if (!redis) return
  try {
    await redis.set(stateKey, JSON.stringify(state), "EX", STATE_TTL_SECONDS)
  } catch {
    /* non-fatal — next run reconstructs */
  }
}

function parseAgeMs(value: string | null): number {
  if (!value) return Date.now()
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : Date.now()
}

function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remaining = minutes % 60
  if (hours < 24) {
    return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  return `${days}d`
}

/** Return current "HH:MM" wall-clock time in the given IANA timezone. */
function currentTimeInTimezone(timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
  // en-GB locale yields "HH:MM" reliably (24-hour, no AM/PM).
  return fmt.format(new Date())
}

/**
 * Check whether the current local "HH:MM" falls within the org's
 * configured working window. Handles wrap-around (e.g., night shift
 * 22:00–06:00) by treating start > end as "spans midnight".
 *
 * Both bounds are treated as inclusive — a clock-out exactly at the end
 * time is still within working hours.
 */
function isWithinWorkingHours(
  nowHHMM: string,
  hours: { start: string; end: string },
): boolean {
  const { start, end } = hours
  // Same-day window: start <= now <= end
  if (start <= end) {
    return nowHHMM >= start && nowHHMM <= end
  }
  // Wrap-around (night shift): now >= start OR now <= end
  return nowHHMM >= start || nowHHMM <= end
}
