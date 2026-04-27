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
XERO_REDIRECT_URI=https://your-domain.com/api/xero/callback
```

Optional:

```env
XERO_SCOPES=offline_access accounting.transactions accounting.contacts
```

`XERO_SCOPES` is configurable because Xero scope requirements vary by app setup and creation date.

## Xero app configuration

In the Xero developer app, add the exact redirect URI you use in `XERO_REDIRECT_URI`.

Example:

```text
https://claimguard.example.com/api/xero/callback
```

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
