# Xero Integration Setup

This app supports one shared Xero connection for the whole system.

## Behavior

- Only admins can start the Xero OAuth flow from the desktop admin portal.
- The connected Xero organization is stored once and shared by the whole application.
- The app can import chart of accounts from Xero so admins can enable which accounts employees can use for claims.
- Automatic Xero bill creation is currently disabled until the final sync stage is confirmed.

## Required environment variables

Add these variables to your deployment environment:

```env
XERO_CLIENT_ID=your-xero-client-id
XERO_CLIENT_SECRET=your-xero-client-secret
```

The OAuth redirect URI is **derived dynamically** from the incoming
request host (`{origin}/api/xero/callback`), so the app works across
multiple hosts (e.g. `hr.altomate.io` and `altomatehr.fusioneta.com.my`)
without an env override. There is no `XERO_REDIRECT_URI` env var.

Optional:

```env
XERO_SCOPES=offline_access accounting.transactions accounting.contacts projects
``` 

`XERO_SCOPES` is configurable because Xero scope requirements vary by app setup and creation date.

## Xero app configuration

In the Xero developer app, register **every host you serve from** as
an allowed redirect URI — Xero supports multiple per app.

Examples for a multi-domain deployment:

```text
https://altomatehr.fusioneta.com.my/api/xero/callback
https://hr.altomate.io/api/xero/callback
https://claimguard.example.com/api/xero/callback
```

The byte-identical-URI requirement between the auth-request step and
the token-exchange step is handled automatically because Xero only
redirects users back to the URI that was sent in step 1 — so the
callback request lands on the same host and the code derives the same
redirect URI on both sides.

## Database update

After pulling these code changes, apply the Prisma schema update before testing the integration:

```bash
npm run db:generate
npm run db:push
```

## Current scope

Today the integration covers:

- admin-only OAuth connection to one Xero org per in-app organization
- importing Xero chart of accounts
- enabling/disabling which imported accounts are selectable during claim submission
