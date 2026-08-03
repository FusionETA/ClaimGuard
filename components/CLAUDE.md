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
- **Long dropdowns get a search box automatically.** `SelectContent`
  (`components/ui/select.tsx`) counts its `SelectItem` children and renders
  a sticky search field once there are more than 7 — see
  `SEARCHABLE_OPTION_THRESHOLD`. Don't hand-roll a filter input inside a
  `SelectContent`; override per-dropdown with `searchable` /
  `searchPlaceholder` if you need to force it on or off. While a query is
  active, `SelectLabel` and `SelectSeparator` rows are hidden so no empty
  section headers are left behind.
- **Dialog/modal scroll areas: always add `pl-1` (or `px-1`) on the
  overflow container.** Inputs, buttons, and focus rings inside a
  `DialogContent`'s scrolling div extend a few pixels past their
  element box; without left padding the ring gets visually clipped
  against the modal's flush-left edge — the bug shows up most
  obviously as a missing/cut purple ring on the first input. The
  canonical class string for a scrolling dialog body is:
    `nice-scrollbar -mr-2 max-h-[65vh] space-y-5 overflow-y-auto py-2 pl-1 pr-2`
  The `-mr-2 pr-2` pair aligns the scrollbar with the modal edge
  while keeping content where it was; `pl-1` is the focus-ring
  breathing room. If you find yourself writing `pr-2` without a
  matching `pl-*`, you've reintroduced this bug — add `pl-1`.

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
