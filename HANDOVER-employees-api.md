# Handover — `/api/v1/employees` create + update fixes

**Audience:** external engineer integrating against ClaimGuard's `/api/v1` employee endpoints.
**Scope:** two bug fixes plus a small DX improvement on the update endpoint. No DB migrations, no breaking changes for callers that already work today.

## Context

ClaimGuard exposes a REST API under `/api/v1/*` so partner applications can manage tenants without going through the in-app admin portal. Authentication is bearer-token (`Authorization: Bearer wp_live_…`), scoped to a single organisation. The employee surface is:

- `GET    /api/v1/employees`           — list (scope `employees:read`)
- `POST   /api/v1/employees`           — create (scope `employees:write`)
- `GET    /api/v1/employees/{id}`      — fetch one (scope `employees:read`)
- `PATCH  /api/v1/employees/{id}`      — partial update (scope `employees:write`)
- `DELETE /api/v1/employees/{id}`      — hard delete (scope `employees:write`)

These mirror the admin portal's "hierarchy" page, and internally call the same `organizationRepository` methods, so the data ends up identical regardless of which surface created it.

## Issues reported

1. `POST /api/v1/employees` returned `{ "ok": true }` only — no employee id, forcing the partner to re-list and reconcile by email/employeeId to recover the new record's id.
2. `PATCH /api/v1/employees/{id}` was returning a Zod validation error claiming `password` was required, even though `password` is not a valid update field.

## Root causes

**Issue 1 — missing id in create response.** The handler in `app/api/v1/employees/route.ts` was discarding the return value of `organizationRepository.createOrganizationMember`, which already returns `{ id: string }`. Pure response-shaping bug; the database write was correct.

**Issue 2 — `password` validation error on PATCH.** The PATCH schema in `app/api/v1/employees/[id]/route.ts` is `.strict()` and does not contain a `password` field, so it cannot have produced that error. The error message — `"password: expected string, received undefined"` — is the exact output of the **create** schema (`createEmployeeSchema`) when `password` is missing. The request was hitting `POST /api/v1/employees` (the collection route) rather than `PATCH /api/v1/employees/{id}`. Most likely cause on the partner side: either the HTTP method was wrong, or `{id}` resolved to an empty string and the URL collapsed to the collection endpoint.

## Fixes shipped

`POST /api/v1/employees` now returns the freshly-created employee using the same projection as `GET /api/v1/employees`. The response shape is:

```json
{
  "data": {
    "id": "<User id — use as the path param on /api/v1/employees/{id}>",
    "employeeProfileId": "<EmployeeProfile id — use on team-membership endpoints>",
    "name": "...", "email": "...", "role": "EMPLOYEE",
    "employeeId": "...", "jobTitle": "...",
    "payoutMethod": "...", "otPayoutMethod": "...",
    "hourlyRate": null,
    "projects": [], "teams": []
  }
}
```

Status remains `201 Created`. If the post-create re-read fails for any reason, the response degrades gracefully to `{ "data": { "id": "<User id>", "employeeProfileId": null } }` so the id is never lost.

`PATCH /api/v1/employees/{id}` gained a defensive guard that fires before Zod validation. If the body contains any create-only field (`password`, `name`, `email`, `employeeId`), the endpoint now returns:

```
400 — Field <name> cannot be updated via PATCH. Use POST /api/v1/employees
to create a new member, or omit this field to update.
```

This makes the misrouting (POST-vs-PATCH or empty `{id}`) immediately obvious instead of surfacing as a confusing schema error.

## What the partner needs to do

For the create flow, switch from "ignore the response, then re-list and match by email" to reading `data.id` and `data.employeeProfileId` straight off the create response. The latter is the value to pass to `POST /api/v1/teams/{id}/members`.

For the update flow, verify three things on the partner side:

1. The resolved request URL is `…/api/v1/employees/<id>` with a non-empty id, not `…/api/v1/employees` or `…/api/v1/employees/`.
2. The HTTP method really is `PATCH` — some client libraries silently rewrite `PATCH` to `POST` and need an explicit `X-HTTP-Method-Override: PATCH` or equivalent.
3. The request body contains only `role`, `jobTitle`, `payoutMethod`, `otPayoutMethod`, `hourlyRate`, `xeroConnectionId`, `projectIds`, and/or `projectAssignments`. Any of `password`, `name`, `email`, `employeeId` will now be rejected explicitly.

Name, email, and password are intentionally not mutable through this endpoint — they live on the `User` row and aren't part of the standard employee-update flow today. If the partner needs those, raise it and we'll spec a `/api/v1/users/{id}` endpoint.

## Files changed

- `app/api/v1/employees/route.ts` — POST handler captures the repo's `{ id }`, re-projects the row, returns the full external shape.
- `app/api/v1/employees/[id]/route.ts` — PATCH handler rejects create-only fields with a self-explanatory 400 before Zod runs.

No changes to schemas, the repo layer, or scopes. Existing successful calls continue to work unchanged.

## Verification

Recommended smoke tests on the partner side:

1. `POST /api/v1/employees` with a valid body → assert `response.data.id` is a non-empty string and `GET /api/v1/employees/{that id}` returns the same record.
2. `PATCH /api/v1/employees/{valid id}` with `{ "jobTitle": "New title" }` → assert `200` and the returned `data.jobTitle` matches.
3. `PATCH /api/v1/employees/{valid id}` with `{ "password": "x" }` → assert `400` and the message references PATCH/POST routing.
4. Confirm a token without `employees:write` is rejected with `403` on both POST and PATCH.
