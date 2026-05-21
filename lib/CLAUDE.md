# lib/ — context for Claude

This folder is the **shared client+server zone**. Anything here should be
safe to import from both server modules and client components.

**Hard rule**: do not put `import "server-only"` modules in `lib/`. If
something is server-only, it belongs in `modules/<module>/...` or in
`app/<route>/...`.

## What lives here

| File | What it does |
|---|---|
| `cache.ts` | Read-through Redis cache: `getOrSetCache(key, ttl, loader)` and `deleteCache(pattern)`. Falls through to the loader when Redis isn't configured (server-only). |
| `cache-invalidation.ts` | Centralised bust helpers: `bustClaimCaches({organizationId, userId?})`, `bustAttendanceCaches({organizationId?, employeeUserId?})`. Action handlers call these instead of building key patterns inline (server-only). |
| `auth/authenticate.ts` | Login (email/password verification, session payload assembly). |
| `auth/password.ts` | Bcrypt-style hash + verify. |
| `auth/session.ts` | Session encoding/decoding, `requirePortalSession(role)`, `requireSessionForRole(role)` (non-redirecting), `resolveActiveOrgId(session)`. |
| `auth/types.ts` | `SessionUser`, `AuthenticatedSession`, `AppRole`. |
| `database-config.ts` | DB connection config from env. |
| `decimal.ts` | `toNumber(value, fallback?)` — single helper for coercing Prisma `Decimal` to JS number. |
| `form-state.ts` | `BaseFormState`, `FormState<V, E>`. Use these for new server actions. |
| `geo.ts` | `checkGeofence`, `DEFAULT_GEOFENCE_RADIUS_METERS`, distance helpers. |
| `mileage.ts` | `computeMileageAmount`, `resolveMileageRate`. Pure, safe on the client. |
| `prisma.ts` | `getPrismaClient()` singleton. Returns null when DB env is missing — callers must guard. |
| `redis.ts` | ioredis singleton + `key(...)` helper for prefixed keys. Returns null when `REDIS_URL` is unset (graceful fallback for local dev) (server-only). |
| `push-notifications.ts` | Web push helpers (used by `web-push.ts`). |
| `utils.ts` | `cn`, `formatCurrency`, `formatShortDate`, `formatMonthLabel`, `formatMonthYear`, `buildInitials`. |
| `web-push.ts` | VAPID key loader + `sendPushToUser`. |
| `xero.ts` | Hand-rolled Xero OAuth + REST client (no SDK). |

## Don't

- Don't add a new `toXxx` Decimal coercion helper — extend `toNumber` if
  you need different fallback behaviour.
- Don't add a new `formatXxx` Date formatter — extend `utils.ts`.
- Don't put a service or repository here. Those live in `modules/`.
- Don't add `import "server-only"` to anything in `lib/` — if you do, the
  client claim form will silently break the next time someone imports it.
