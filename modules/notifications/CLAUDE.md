# Notifications module — context for Claude

Owns the `PushSubscription` table (web-push device registrations) and the
`Notification` table (persisted in-app notifications shown in the header
bell on both surfaces).

## What lives here

- `infrastructure/push-subscription.repository.ts` — `upsertForUserEmail`
  (create-or-update by endpoint) and `deleteForUserEmail` (security-scoped
  delete that joins on user.email so endpoints from other users can't be
  removed via a forged endpoint string).
- `domain/models.ts` — `NotificationType` (mirrors the Prisma enum,
  keep in sync) + `NotificationView` (ISO-string dates, client-safe).
- `infrastructure/notification.repository.ts` — `create`, `listForUser`,
  `unreadCount`, `markRead`, `markAllRead`. All `prisma.notification.*`
  access lives here.
- `application/services/notification.service.ts` — **`notify(...)`** is the
  single funnel for delivering a notification: it persists a row AND sends
  the web push, both best-effort. Plus `getNotificationsForUser`,
  `markNotificationRead`, `markAllNotificationsRead`.

## When to use it

- To **send a notification**, call `notify(...)` from the service — NOT
  `sendPushToUser` directly. `notify` writes the persisted row (so it
  shows in the bell) and sends the push in one call. All existing call
  sites (claim submit/review, the attendance + temporary-review crons)
  already go through it.
- The bell UI (`components/layout/notification-bell.tsx`, mounted in both
  shells) reads `GET /api/notifications` and marks read via
  `POST /api/notifications/read`.
- The two `/api/push/{subscribe, unsubscribe}` routes still use the
  push-subscription repository for device registration.

`sendPushToUser` from `lib/web-push.ts` is now an implementation detail of
`notify` — prefer `notify` unless you specifically want a push WITHOUT a
persisted in-app record. Failures are swallowed — never block a primary
action on a notification.

## Don't

- Don't call `prisma.pushSubscription` directly from routes or actions —
  always go through `pushSubscriptionRepository`.
- Don't surface push failures to users — log them and move on.
