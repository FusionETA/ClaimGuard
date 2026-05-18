import "server-only"

import type { Prisma } from "@/generated/prisma/client"
import { getPrismaClient } from "@/lib/prisma"

/**
 * Repository for the bulk-employee-import wizard's resumable draft.
 *
 * One draft per (userId, organizationId). The wizard auto-saves on
 * every state change (debounced); next time the admin opens the
 * dialog, `getForUser` returns the latest non-expired draft and the
 * UI shows a Continue / Discard panel.
 *
 * `state` is a structurally-opaque JSON blob keyed by the wizard
 * component — the repo doesn't validate its shape. The wizard's
 * loader is tolerant of partial / older blobs so a code update to the
 * wizard doesn't break in-flight drafts.
 *
 * Drafts older than `DRAFT_TTL_MS` are purged on every read. Cheap
 * lazy cleanup — no separate cron job.
 */
export type ImportDraftRow = {
  id: string
  userId: string
  organizationId: string
  fileName: string | null
  step: string
  rowCount: number
  state: Prisma.JsonValue
  createdAt: Date
  updatedAt: Date
}

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export const importDraftRepository = {
  /**
   * Returns the active (non-expired) draft for this user+org, or null.
   * Lazily purges any expired draft as a side effect.
   */
  async getForUser(input: {
    userId: string
    organizationId: string
  }): Promise<ImportDraftRow | null> {
    const prisma = getPrismaClient()
    if (!prisma) return null

    const row = await prisma.employeeImportDraft.findUnique({
      where: {
        userId_organizationId: {
          userId: input.userId,
          organizationId: input.organizationId,
        },
      },
    })
    if (!row) return null

    const ageMs = Date.now() - row.updatedAt.getTime()
    if (ageMs > DRAFT_TTL_MS) {
      // Expired — drop it lazily and return null. Don't wait on the
      // delete; if it races a concurrent save we'll just see another
      // expired row next time.
      void prisma.employeeImportDraft
        .delete({ where: { id: row.id } })
        .catch(() => {
          /* swallow — best-effort purge */
        })
      return null
    }

    return row
  },

  /**
   * Upsert this admin's draft. Replaces the JSON blob wholesale —
   * the wizard always sends the full state, not patches.
   */
  async upsert(input: {
    userId: string
    organizationId: string
    fileName: string | null
    step: string
    rowCount: number
    state: Prisma.InputJsonValue
  }): Promise<ImportDraftRow> {
    const prisma = getPrismaClient()
    if (!prisma) throw new Error("Database is not configured.")

    return await prisma.employeeImportDraft.upsert({
      where: {
        userId_organizationId: {
          userId: input.userId,
          organizationId: input.organizationId,
        },
      },
      create: {
        userId: input.userId,
        organizationId: input.organizationId,
        fileName: input.fileName,
        step: input.step,
        rowCount: input.rowCount,
        state: input.state,
      },
      update: {
        fileName: input.fileName,
        step: input.step,
        rowCount: input.rowCount,
        state: input.state,
      },
    })
  },

  /**
   * Idempotent — silently no-ops when no draft exists for this admin.
   */
  async deleteForUser(input: {
    userId: string
    organizationId: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return

    await prisma.employeeImportDraft
      .delete({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: input.organizationId,
          },
        },
      })
      .catch(() => {
        /* swallow — no draft to delete */
      })
  },
}
