# app/ — context for Claude

Next.js 15 App Router. Two route groups, plus `api/` and `login/`.

## Layout

- `app/(admin)/admin/` — admin-only routes (claims, hierarchy, leave,
  settings, attendance + sub-routes).
- `app/(employee)/employee/` — shared by EMPLOYEE and SUPERVISOR roles
  (dashboard, claims, leave, account, attendance, review).
- `app/api/` — REST endpoints. The push subscribe/unsubscribe routes,
  Xero OAuth callback, and a few `/api/*/context` routes used by client
  polling.
- `app/login/` — login page + action.
- `app/page.tsx` — root redirect by role.

## Hard rules for pages and routes

1. **Pages and API routes call services only**, never repositories or
   Prisma directly. If a page needs a bag of data, add a
   `getXxxPageData()` service in
   `modules/claims/application/services/admin-page-data.service.ts` (or
   the equivalent module-page-data file).
2. Pages handle: session + role check (`getCurrentSession` +
   `redirect("/login")`), reading cookies/searchParams, and rendering.
   That's it.
3. Server actions live in `<route>/actions.ts`. They:
   - Validate the session.
   - Validate input with Zod.
   - Call services.
   - Call `revalidatePath(...)` for any affected route.
   - Return a `FormState`-shaped result.

## Common patterns

- **Active org resolution**: `resolveActiveOrgId(session)` from
  `lib/auth/session.ts`. Don't open-code `session.activeOrganizationId ?? session.organizationId`.
- **Admin auth gate**: pages do `if (!session || session.role !== "ADMIN") redirect("/login")`.
  Server actions do the same. There's no middleware-level check beyond
  what's in `middleware.ts` (which only handles unauth → /login).
- **Form state typing**: existing routes have hand-written form-state
  files. New routes should use `FormState<V, E>` from
  `lib/form-state.ts`.
- **Cookies**: read via `await cookies()` (Next.js 15 made it async). The
  active Xero connection cookie is `claimguard_active_connection`; the
  pending OAuth cookie is `claimguard_xero_pending`.

## Don't

- Don't call `prisma.*` from a page or API route. Even if it's "just one
  query", add a repo method.
- Don't call repositories directly from a page either. Pages call services.
- Don't put business logic in actions.ts — it should orchestrate (parse
  form, call service, revalidate). Logic belongs in the service.
- Don't use `localStorage` to remember admin choices — use the session.
