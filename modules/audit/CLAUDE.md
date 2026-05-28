# modules/audit/ — context for Claude

Per-organization audit / activity log. Records who did what (and what
failed) inside each org for the last 7 days. The retention prune is a
daily cron at `/api/cron/audit-prune`.

## Layers

- **domain/** — `models.ts` with `AuditLogEntry`, `AuditStatus`,
  `AuditActorRole`, `AuditLogFilter`.
- **application/services/** — `audit-log.service.ts`:
  - `writeAudit({...})` — fire-and-forget writer. **Failures are
    swallowed and console-logged. Never wrap in try/catch.** Calling
    it should never affect the user action that triggered it.
  - `listAuditEntries(orgId, filter)` — paged read for the Settings →
    Activity log tab.
  - `pruneAuditLog()` — deletes rows older than 7 days. Cron uses this.
- **infrastructure/** — `audit-log.repository.ts`, all Prisma access.

## Action naming convention

Use `module.verb` (e.g. `claim.approve`, `attendance.session.edit`,
`admin.add`). Keep verbs lowercased. The Settings tab filters by
`actionPrefix` so consistent namespacing makes "show me all claim
events" a single string match.

Curate the list — only events an admin would actually want to see in
the activity feed. Skip every form keystroke, page view, cache miss.

## Calling pattern

```ts
import { writeAudit } from "@/modules/audit/application/services/audit-log.service"

// At the end of a successful service action:
void writeAudit({
  organizationId: orgId,
  actor: { userId, email, name, role },
  action: "claim.approve",
  status: "SUCCESS",
  summary: `Approved Claim ${claim.id} (${formatMyr(claim.amount)})`,
  targetType: "claim",
  targetId: claim.id,
})

// In a catch block for an intentional user attempt that failed:
void writeAudit({
  organizationId: orgId,
  actor: { userId, email, name, role },
  action: "claim.approve",
  status: "FAILED",
  summary: `Tried to approve Claim ${claim.id}`,
  errorReason: err.message,
  targetType: "claim",
  targetId: claim.id,
})
```

The `void` discards the promise — we never block on the write.

## Don't

- Don't log system exceptions or stack traces. Those go to `lib/log.ts`
  (the structured app logger). The audit feed is for human-readable
  user activity only.
- Don't `await` the audit write inside a hot user-facing path —
  prepend `void` so it never adds latency, and the service catches
  errors internally anyway.
- Don't add module-specific audit columns. The `metadata: Json?`
  field is the escape hatch for any extra context you want to attach.
