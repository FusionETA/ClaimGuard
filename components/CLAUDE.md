# components/ — context for Claude

Reusable React components. Subfolders:

- `ui/` — **canonical** design-system primitives (Button, Card, Input,
  Label, Select, Textarea, Dialog, Avatar, Badge, etc). All shadcn-derived.
  This is the set everything new should import from.
- `attendance/ui/` — historical fork of the primitives with attendance-
  specific tweaks (button padding, badge variants for clock states, etc).
  3 of these (label, separator, avatar) now re-export from `components/ui`.
  The other 5 (card, button, input, dialog, badge) genuinely differ —
  don't touch them without auditing the visual impact across attendance
  pages.
- `admin/` — admin-portal feature components (settings panel, hierarchy
  table, claims table, executive overview, Xero connection card).
- `claims/` — shared claim UI (status badge, queue, history, charts,
  metric card, review actions).
- `attendance/` — employee/supervisor attendance views.
- `layout/` — `admin-shell.tsx` and `employee-shell.tsx` — sidebar nav +
  org switcher + bottom mobile nav.
- `pwa/` — service worker registration, push notification prompt.

## Conventions

- Use `cn(...)` from `lib/utils.ts` for class-name composition. Never raw
  string concatenation.
- For server-action forms: `useActionState` + `useToastOnAction(state)`
  from `components/ui/toaster.tsx`. Do NOT write a manual `useEffect` for
  toast feedback.
- For unfinished features, use `<ComingSoonCard title body />` from
  `components/ui/coming-soon-card.tsx`. Don't write another Construction-
  icon card inline.
- Field validation errors: set `aria-invalid` on the input and render
  `<FieldError message={state.errors?.x} />` (the `Input` and `Textarea`
  primitives already have `aria-invalid` styling — red border + ring).
- Status filter dropdowns for claims: use `visibleStatusOptions` from
  `modules/claims/domain/models.ts`, NOT a local `claimStatuses.filter(...)`.

## Big files

- `admin/admin-settings-panel.tsx` is ~1800 lines. It owns the entire
  4-tab Settings UI plus 13 `useActionState` hooks. Each tab body is
  fenced with `{activeTab === "x" ? (` so it's still navigable. A future
  refactor would split each tab into its own file under
  `components/admin/settings/`.
- `admin/admin-claims-table.tsx`, `claims/admin-claims-queue.tsx`,
  `claims/employee-claims-history.tsx` — three claim-list views with
  shared filtering logic. Use `claimMatchesStatusFilter` from the claims
  domain.
