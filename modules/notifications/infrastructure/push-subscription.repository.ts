import "server-only"

import { getPrismaClient } from "@/lib/prisma"

/**
 * Persistence for web-push subscriptions. Both `/api/push/{subscribe,
 * unsubscribe}` route handlers used to call Prisma directly — moved here so
 * the routes stay thin and the DB shape stays in one place.
 */
export const pushSubscriptionRepository = {
  async upsertForUserEmail(data: {
    email: string
    endpoint: string
    p256dh: string
    auth: string
  }): Promise<{ ok: true } | { ok: false; reason: "no-db" | "user-not-found" }> {
    const prisma = getPrismaClient()
    if (!prisma) return { ok: false, reason: "no-db" }

    // Email is no longer DB-unique — pick the active row. Archived
    // accounts shouldn't be receiving new push subscriptions.
    const user = await prisma.user.findFirst({
      where: {
        email: data.email,
        OR: [
          { employeeProfile: null },
          { employeeProfile: { payrollProfile: null } },
          { employeeProfile: { payrollProfile: { isArchived: false } } },
        ],
      },
      select: { id: true },
    })
    if (!user) return { ok: false, reason: "user-not-found" }

    await prisma.pushSubscription.upsert({
      where: { endpoint: data.endpoint },
      update: { p256dh: data.p256dh, auth: data.auth, userId: user.id },
      create: {
        userId: user.id,
        endpoint: data.endpoint,
        p256dh: data.p256dh,
        auth: data.auth,
      },
    })
    return { ok: true }
  },

  /**
   * Delete a subscription by endpoint, but only if it belongs to the given
   * user (verified by joining on `user.email`). Silently swallows missing-
   * row errors since the caller doesn't care whether the row was already gone.
   */
  async deleteForUserEmail(data: {
    email: string
    endpoint: string
  }): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return

    await prisma.pushSubscription
      .deleteMany({
        where: {
          endpoint: data.endpoint,
          user: { email: data.email },
        },
      })
      .catch(() => {
        // subscription may already be gone — not worth surfacing
      })
  },

  /**
   * Delete every push subscription belonging to the given user. Called from
   * `logoutAction` so the server-side state never lingers — even if the
   * client-side `pushManager.unsubscribe()` step didn't run (browser
   * closed mid-logout, network blip, JS disabled, etc.). Without this,
   * the DB row keeps pointing at the device and the user keeps receiving
   * notifications for the previous account.
   *
   * Silently swallows missing-row errors — by the time the caller's
   * session is cleared, there's nothing useful to do with a failure
   * here anyway.
   */
  async deleteAllForUserEmail(email: string): Promise<void> {
    const prisma = getPrismaClient()
    if (!prisma) return

    await prisma.pushSubscription
      .deleteMany({
        where: { user: { email } },
      })
      .catch(() => {
        // best-effort cleanup — not worth surfacing
      })
  },
}
