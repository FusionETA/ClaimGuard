# Notifications module — context for Claude

Tiny module — just owns the `PushSubscription` table.

## What lives here

`infrastructure/push-subscription.repository.ts` — `upsertForUserEmail`
(create-or-update by endpoint) and `deleteForUserEmail` (security-scoped
delete that joins on user.email so endpoints from other users can't be
removed via a forged endpoint string).

## When to use it

The two `/api/push/{subscribe, unsubscribe}` route handlers call it. Any
new code that touches `PushSubscription` should also go through the
repository, never `prisma.pushSubscription` directly.

For *sending* a push (not subscribing), the helper is `sendPushToUser` from
`lib/web-push.ts`. It loads VAPID keys, looks up the user's subscriptions,
and POSTs to each endpoint. Failures are swallowed — never block a primary
action on a push notification.

## Don't

- Don't call `prisma.pushSubscription` directly from routes or actions —
  always go through `pushSubscriptionRepository`.
- Don't surface push failures to users — log them and move on.
