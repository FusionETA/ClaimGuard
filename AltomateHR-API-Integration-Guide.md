# AltomateHR API — Integration Guide for External Partners

**Audience:** External engineers integrating a partner application (e.g. an HR portal, customer admin app, or onboarding service) with AltomateHR.
**Scope:** Provisioning new tenants, then managing projects and teams on a tenant's behalf.
**Base URL (dev):** `https://workpulse-dev.fusioneta.com.my`
**API version:** `v1` (every response carries `X-API-Version: v1`)

---

## 1. Mental model

AltomateHR is multi-tenant. Each customer your platform onboards becomes one AltomateHR `Organization`. Your backend authenticates with two separate kinds of tokens — never mix them up:

| Token | Prefix | Scope of use | Stored on your side |
|---|---|---|---|
| **Master API key** | `wp_master_…` | ONLY `/api/v1/admin/*` — provisioning new tenants. | One per partner. Treat it like a root credential. |
| **Per-org token** | `wp_live_…` | All `/api/v1/*` (non-admin) endpoints on behalf of a single tenant. | One per customer. Issued at provisioning time. Shown ONCE. |

**Why two tokens.** A leaked master key can create new empty tenants but cannot read any existing customer's data. A leaked per-org token only exposes that one customer. Compromise is contained.

**Data model your app touches.**

```
Organization (tenant)
└── Project (a worksite / engagement; manual or Xero-imported)
    └── Team (an approval chain attached to one project)
        └── Members (employees, each pinned to a layer 1..N)
            └── Per-(member, team) approval chain (optional override)
```

Modules a team's chain governs: `CLAIMS`, `OT`, `LEAVE`, `ATTENDANCE`. The team's `moduleConfig` says, per module, which 1-indexed layers must approve.

---

## 2. End-to-end onboarding sequence

The expected flow when one of your customers finishes setup in your app:

1. Your backend calls `POST /api/v1/admin/organizations` with the master key.
2. Server returns the new `organization.id` and a **per-org token** (`apiToken.secret`, `wp_live_…`). This is the only time the secret is exposed.
3. Persist this mapping on your side (see §3 schema). One of your `userId`s should map to exactly one AltomateHR tenant — enforce that as a unique constraint.
4. From now on, every AltomateHR call you make for that customer uses the per-org token, **not** the master key.
5. (Optional) Bootstrap initial projects and teams via `POST /api/v1/projects` and `POST /api/v1/teams` while the user is still in your setup wizard.

If the same user re-runs setup, look up the mapping first — provisioning a new org would produce a duplicate tenant. The provisioning endpoint also returns 409 if you try to re-use an org name.

---

## 3. Storage requirements on the partner side

Recommended schema (Postgres-flavoured; adapt freely):

```sql
CREATE TABLE workpulse_tenant (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL UNIQUE,           -- your platform's user
  organization_id     TEXT NOT NULL UNIQUE,           -- AltomateHR Organization.id
  organization_name   TEXT NOT NULL,
  api_token_encrypted BYTEA NOT NULL,                 -- wp_live_… encrypted at rest
  api_token_prefix    TEXT NOT NULL,                  -- e.g. "wp_live_a1b2" for UI/audit
  integration_id      TEXT NOT NULL,                  -- AltomateHR ApiIntegration.id (for token rotation later)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at        TIMESTAMPTZ
);
```

Notes:
- **`user_id UNIQUE`** enforces "one user → one tenant".
- **`organization_id UNIQUE`** prevents accidentally pointing two of your users at the same AltomateHR tenant.
- **Encrypt the token at rest.** It is a bearer credential — anyone holding it can act as the entire tenant. Use your platform's KMS / sealed-secret pattern; never log it.
- **Store the prefix unencrypted** so support staff can identify a token (`wp_live_a1b2…`) without decrypting.
- **Don't store the master key in this table.** It belongs in your secret manager, not in customer rows.

If/when token rotation ships, you'll keep `integration_id` to identify which `ApiIntegration` to roll, then overwrite the encrypted secret in place.

---

## 4. Authentication

Every request:

```
Authorization: Bearer <token>
Content-Type: application/json
```

- Calls to `/api/v1/admin/*` require `wp_master_*`.
- Calls to all other `/api/v1/*` endpoints require `wp_live_*`.
- The wrong token kind on the wrong endpoint returns **401**, not 403, with a clear message.
- Tokens carry **scopes**. The default per-org token issued at provisioning has all 17 scopes; if you ever issue a narrower token, missing scopes return **403** with the exact scope name in the message.

The server resolves the tenant from the token. **You never pass `organizationId` in URLs or bodies** for `/api/v1/*` — attempting to access another tenant's resource by id returns 404, identical to "not found", so existence cannot be probed across tenants.

Every successful authenticated request is recorded to an audit log on the server side (method, path, status, IP). Failed auth attempts are not attributed (no integration to attribute to).

---

## 5. Provisioning a tenant — `POST /api/v1/admin/organizations`

**Auth:** master key.

**Request:**

```json
{
  "name": "Acme Sdn Bhd",
  "tokenLabel": "Acme — production"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | 2–120 chars, globally unique across AltomateHR. |
| `tokenLabel` | string | no | ≤120 chars. Defaults to `"<partnerName> (auto-issued)"`. Useful for distinguishing tokens later. |

**Success — 201:**

```json
{
  "organization": { "id": "org_…", "name": "Acme Sdn Bhd" },
  "apiToken": {
    "secret":        "wp_live_…",
    "prefix":        "wp_live_a1b2",
    "scopes":        ["employees:read", "employees:write", "…"],
    "integrationId": "intg_…"
  }
}
```

**Persist `apiToken.secret` immediately.** It is unrecoverable after this response.

**Errors:** 400 (validation), 401 (bad master key), 409 (org name taken), 503 (DB unavailable), 500 (server error).

---

## 6. Projects API

Base path: `/api/v1/projects`. Auth: per-org token. All handlers scope strictly by the tenant resolved from the token.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/api/v1/projects` | `projects:read` | List. Optional `?isManual=true\|false`. |
| POST | `/api/v1/projects` | `projects:write` | Create a manual project. |
| GET | `/api/v1/projects/{id}` | `projects:read` | Get one. |
| PATCH | `/api/v1/projects/{id}` | `projects:write` | Update managers / location / lat / long. |
| DELETE | `/api/v1/projects/{id}` | `projects:write` | Delete (manual only). |
| POST | `/api/v1/projects/{id}/managers` | `projects:write` | Add a manager. |
| DELETE | `/api/v1/projects/{id}/managers/{userId}` | `projects:write` | Remove a manager. |

### Manual vs Xero-imported

A `Project` with `isManual: true` is partner-created via this API. With `isManual: false`, it came from a Xero sync — it appears in lists but **DELETE returns 409**, and most fields are owned by Xero. Only manage Xero-imported projects through the Xero workspace, not this API.

### Create body

```json
{
  "name": "Acme Site KL",
  "projectManagerIds": ["user_…"],
  "location": "Kuala Lumpur",
  "latitude": 3.139,
  "longitude": 101.6869
}
```

`name` is required (2–120). `projectManagerIds` must already exist as `SUPERVISOR` or `ADMIN` users in the org. Latitude/longitude validated to ±90/±180.

### Patch body (all optional)

```json
{
  "projectManagerIds": ["user_…"],
  "location": "Penang",
  "latitude": 5.4141,
  "longitude": 100.3288
}
```

`name`, working hours, and holidays are intentionally **not** in this payload yet. They live behind dedicated flows in the admin UI; flag them if you need them and we can add sub-endpoints.

### Response shape (single project)

```json
{
  "data": {
    "id": "proj_…",
    "name": "Acme Site KL",
    "status": "ACTIVE",
    "isManual": true,
    "location": "Kuala Lumpur",
    "latitude": 3.139,
    "longitude": 101.6869,
    "workingHoursStart": null,
    "workingHoursEnd": null,
    "workingDays": null,
    "projectManagers": [],
    "holidays": [],
    "xeroConnectionId": null,
    "xeroProjectId": null
  }
}
```

---

## 7. Teams API

Base path: `/api/v1/teams`. Auth: per-org token.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/api/v1/teams` | `teams:read` | List. Optional `?projectId=`. |
| POST | `/api/v1/teams` | `teams:write` | Create team under a project. |
| GET | `/api/v1/teams/{id}` | `teams:read` | Get team incl. members. |
| PATCH | `/api/v1/teams/{id}` | `teams:write` | Edit name / layers / labels / module config. |
| DELETE | `/api/v1/teams/{id}` | `teams:write` | Delete (must have no members). |
| GET | `/api/v1/teams/{id}/members` | `teams:read` | List members + per-member approval chain. |
| POST | `/api/v1/teams/{id}/members` | `teams:write` | Upsert a member at a layer; optionally set chain. |
| DELETE | `/api/v1/teams/{id}/members/{membershipId}` | `teams:write` | Remove a member. |

### Create team body

```json
{
  "projectId": "proj_…",
  "name": "Approvals — Site Ops",
  "layerCount": 3,
  "layerLabels": ["IC", "Manager", "Director"],
  "moduleConfig": {
    "CLAIMS":     [2, 3],
    "OT":         [2, 3],
    "LEAVE":      [2],
    "ATTENDANCE": [2]
  }
}
```

- `projectId`, `name` (2–120), `layerCount` (1–10) are required.
- `layerLabels` is optional and ≤10 entries; if omitted, layers display as "Layer 1", "Layer 2", …
- `moduleConfig` is optional. Defaults to "every layer approves every module". Each value is an array of 1-indexed layer numbers that must approve for that module.
- The repo verifies `projectId` belongs to the same org. A foreign id surfaces as **404 — Project not found in this organization**.

### Patch team body (all optional)

```json
{
  "name": "Renamed",
  "layerCount": 4,
  "layerLabels": ["IC","Lead","Mgr","Dir"],
  "moduleConfig": { "CLAIMS": [3, 4] }
}
```

- Pass `"layerLabels": null` to revert to defaults.
- Shrinking `layerCount` below an existing member's layer returns **409**. Move/remove those members first.

### Add team member body

```json
{
  "employeeProfileId": "emp_profile_…",
  "layer": 2,
  "chain": [
    { "layer": 1, "userId": "user_…" },
    { "layer": 2, "userId": "user_…" }
  ]
}
```

- `employeeProfileId` is the **EmployeeProfile id**, not the user id and not the human-readable employee code.
- POST has **upsert semantics**: re-POSTing the same `(employeeProfileId, teamId)` updates the layer instead of erroring.
- `chain` is optional. Setting it pins a per-(employee, team) override for that member's approval path; otherwise the team-level chain is used.

### Member response shape

```json
{
  "data": {
    "membershipId": "mbr_…",
    "employeeProfileId": "emp_profile_…",
    "userId": "user_…",
    "name": "…",
    "role": "EMPLOYEE",
    "layer": 2,
    "chain": [{ "layer": 1, "userId": "user_…" }, { "layer": 2, "userId": "user_…" }]
  }
}
```

---

## 8. Error contract (all `/api/v1/*` endpoints)

```json
{
  "error": {
    "status": 400,
    "message": "Validation failed.",
    "details": { /* present on Zod failures only */ }
  }
}
```

| Status | When |
|---|---|
| 400 | Malformed JSON or Zod validation failure (see `details.fieldErrors`). |
| 401 | Missing / malformed / revoked token, or wrong token kind for the endpoint. |
| 403 | Token authenticated but missing the required scope. |
| 404 | Resource not in the tenant (or doesn't exist — indistinguishable on purpose). |
| 409 | Business-rule conflict: name taken, members still attached, Xero-imported, layer-shrink with members, etc. The `message` is human-readable. |
| 503 | Database not configured / unavailable. |
| 500 | Unhandled server error. Audit-logged with the error message. |

Standard headers on every response: `Cache-Control: private, no-store`, `X-API-Version: v1`.

---

## 9. Reference flows

### A. Onboarding a customer end-to-end

```
Customer finishes setup in partner app
        │
        ▼
POST /api/v1/admin/organizations           ← master key
        │ returns wp_live_… (once)
        ▼
Persist (user_id, organization_id, encrypted token)
        │
        ▼
POST /api/v1/projects (×N, optional)       ← per-org token
        │
        ▼
POST /api/v1/teams (×N, optional)
        │
        ▼
POST /api/v1/teams/{id}/members (×N)
```

### B. Adding a new team to an existing tenant

1. Lookup the tenant row by `user_id`. Decrypt the per-org token.
2. `POST /api/v1/teams` with the desired `projectId`, `name`, `layerCount`.
3. For each employee, `POST /api/v1/teams/{id}/members` with `employeeProfileId` and `layer`.

### C. Editing a project's project managers

1. Decrypt the per-org token for the customer.
2. `PATCH /api/v1/projects/{id}` with `{ "projectManagerIds": [...] }`. The list is a full replacement, not a delta.

---

## 10. Operational expectations

- **Idempotency:** the create endpoints are NOT idempotent — re-POSTing the same project name within an org returns 409. Either look up the resource first, or surface the 409 to the user. Member assignment IS upsert.
- **Rate limits:** none enforced today. Be reasonable. Bulk operations should be sequenced server-to-server, not parallelised aggressively.
- **Token rotation:** not yet exposed via API. Until it ships, plan for "issue new token, swap, retire old" by holding `integration_id` against the customer record so you can identify which integration row to rotate later.
- **Webhooks / callbacks:** not currently provided. AltomateHR won't push events back to your app — your app polls or acts on user input.
- **Audit:** every successful authenticated call writes an audit row server-side keyed on `integration_id`. Use this for support escalations.
- **Time zones:** all timestamps in responses are ISO 8601 UTC.
- **Pagination:** `/api/v1/employees` paginates with `limit` (default 50, max 200) and `offset`. Projects and teams currently return everything; expect that to grow into pagination — code defensively against `data.length` rather than hard-coded sizes.

---

## 11. Quickstart — Node example

```js
const BASE = "https://workpulse-dev.fusioneta.com.my";
const MASTER = process.env.WORKPULSE_MASTER_KEY;     // wp_master_…

// 1. Provision a tenant
const provRes = await fetch(`${BASE}/api/v1/admin/organizations`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${MASTER}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name: "Acme Sdn Bhd", tokenLabel: "Acme — prod" }),
});
if (!provRes.ok) throw new Error(`Provision failed: ${provRes.status}`);
const { organization, apiToken } = await provRes.json();

// 2. Persist (organization.id, apiToken.secret) keyed on your user_id.
//    apiToken.secret is unrecoverable after this point.
await db.workpulse_tenant.create({
  user_id: currentUserId,
  organization_id: organization.id,
  organization_name: organization.name,
  api_token_encrypted: kms.encrypt(apiToken.secret),
  api_token_prefix: apiToken.prefix,
  integration_id: apiToken.integrationId,
});

// 3. Use the per-org token for everything else.
const orgToken = apiToken.secret; // or kms.decrypt(row.api_token_encrypted)
const orgHeaders = {
  Authorization: `Bearer ${orgToken}`,
  "Content-Type": "application/json",
};

const proj = (await (await fetch(`${BASE}/api/v1/projects`, {
  method: "POST",
  headers: orgHeaders,
  body: JSON.stringify({ name: "Acme Site KL", location: "Kuala Lumpur" }),
})).json()).data;

const team = (await (await fetch(`${BASE}/api/v1/teams`, {
  method: "POST",
  headers: orgHeaders,
  body: JSON.stringify({
    projectId: proj.id,
    name: "Approvals — Site Ops",
    layerCount: 3,
    layerLabels: ["IC", "Manager", "Director"],
  }),
})).json()).data;
```

---

## 12. Checklist before you go live

- [ ] Master key stored in a secret manager, never in source or in customer rows.
- [ ] `workpulse_tenant` table created with unique constraints on `user_id` and `organization_id`.
- [ ] Per-org token encrypted at rest; only the prefix logged or rendered to staff.
- [ ] Provisioning failure path: 409 on duplicate name surfaces a friendly retry to the user.
- [ ] Re-running setup looks up `workpulse_tenant.user_id` first and never re-provisions.
- [ ] Error handler distinguishes 401 (re-auth), 403 (scope gap — file an issue), 404 (resource gone), 409 (business conflict — show user-friendly message).
- [ ] Audit identifiers (`integration_id`, `organization_id`) attached to your platform's request logs so support can correlate.

---

## 13. Open questions / things to confirm before integration

1. **Token rotation policy.** Does the partner need a path to rotate `wp_live_*` without disturbing the tenant's data? Today there's no rotate endpoint — coordinate before launch if rotation is a security requirement on your side.
2. **Project name updates.** Not currently in `PATCH /api/v1/projects/{id}`. Confirm whether this is needed; if yes, it requires a server-side change.
3. **Employee provisioning.** Members reference `employeeProfileId`. How are employees created in the tenant in your flow — through AltomateHR's admin UI, an existing employee sync, or a future `POST /api/v1/employees` flow?
4. **Production base URL.** This guide uses the dev host. Confirm the production URL and master key separately.
5. **Webhooks.** If your app needs to react to AltomateHR-side state changes (e.g. claim approved), we'll need to scope a webhook delivery channel; it doesn't exist today.

Send these answers back and we can lock down the integration plan.
