/**
 * Capability catalogue advertised by `GET /api/v1/whoami`.
 *
 * WHY THIS EXISTS: partner clients validate their PATCH bodies with
 * `.strict()` schemas on their side, and ours reject unknown keys too —
 * so a single field we haven't shipped yet 400s the whole call,
 * including the fields that DO work. Without a capability list the only
 * way to add a field is to coordinate deploy dates by hand, and a
 * slipped or rolled-back release silently breaks the partner's form.
 *
 * With it, the partner reads `features` from the token-introspection
 * call they already make, and gates each optional block on the matching
 * flag. Nothing to coordinate, and a rollback degrades instead of
 * breaking.
 *
 * RULES:
 *   1. Names are `<resource>.<block>` and are PERMANENT once shipped —
 *      a partner's `if (features.includes(...))` depends on them.
 *   2. Add a flag in the same commit that ships the capability, never
 *      ahead of it. The flag's contract is "you may send this today".
 *   3. Never remove a flag for a capability that still works. If one is
 *      genuinely withdrawn, drop the flag first, give partners a
 *      release to stop sending it, then remove the handling.
 */
export const API_FEATURE_CATALOG = [
  // ── /api/v1/settings ────────────────────────────────────────────────
  /// PATCH accepts `name` (was a documented 501 before this shipped).
  "settings.name",
  /// GET returns + PATCH accepts `workingDays` / `nonWorkingDays` as
  /// weekday-name arrays. Org-wide default; projects can override.
  "settings.workingDays",
  /// `GET`/`PUT /api/v1/settings/holidays` — org-wide public-holiday
  /// calendar as an explicit date list, replaced per year.
  "settings.holidays",

  // ── /api/v1/payroll-settings ────────────────────────────────────────
  /// GET returns + PATCH accepts the `profile` block (employer name,
  /// email, phone, correspondence address) used on payslips + EA/CP8D.
  "payroll-settings.profile",
  /// `profile.companyType` (partner vocabulary, lossily mapped) and
  /// `profile.employerCategory` (LHDN vocabulary, verbatim) are
  /// writable. Separate flag from `profile` because it shipped later.
  "payroll-settings.companyType",
  /// GET returns + PATCH accepts the `calculation` block
  /// (`prorationBasis`, `hrdf`). See the block's docs for which of the
  /// partner-proposed rules are fixed engine behaviour rather than
  /// settings.
  "payroll-settings.calculation",
  /// GET returns + PATCH accepts the `bank` block (bulk-payment payor
  /// account + BIC).
  "payroll-settings.bank",
  /// The `bank` block additionally accepts `bankName`,
  /// `accountHolderName` and `organisationCode`, and the GET reports
  /// `supportedFormats` / `activeFormat` / `availableBanks`. Separate
  /// flag from `bank` because those shipped later, alongside the
  /// bank-agnostic disbursement CSV.
  "payroll-settings.bankDetails",
  /// PATCH accepts `zakatNumber` (employer registration, one per org).
  "payroll-settings.zakatNumber",

  // ── /api/v1/projects ────────────────────────────────────────────────
  /// PATCH accepts the `calendar` block (working hours, working days,
  /// lunch break) so a multi-site org can run different working weeks
  /// per location.
  "projects.calendar",
  /// `GET`/`PUT /api/v1/projects/[id]/holidays` — per-project holiday
  /// calendar, same year-scoped replace semantics as the org one.
  "projects.holidays",

  // ── /api/v1/pending ─────────────────────────────────────────────────
  /// `GET /api/v1/pending` — org-wide counts of everything waiting on a
  /// human (claims, leave, attendance/OT, payroll runs in
  /// PENDING_APPROVAL). Sections the token lacks scope for are omitted
  /// and named, not 403'd.
  "pending.inbox",

  // ── reference + reporting reads ─────────────────────────────────────
  /// `GET /api/v1/payroll/adjustment-categories` — the payroll item
  /// dictionary with EPF/SOCSO/EIS/PCB/HRDF treatment per category.
  /// Read this before writing any adjustment: the category, not the
  /// amount, is what a caller gets wrong.
  "payroll.adjustmentCategories",
  /// `GET /api/v1/audit` — org activity log with actor, action and
  /// `partnerInitiated`. Uses the `settings:read` scope.
  "audit.read",
  /// `GET /api/v1/loans` — staff loans + repayment schedules.
  "loans.read",
  /// `GET /api/v1/employees/{id}/salary-history` — salary changes for
  /// one employee, keyed by User id like the rest of the resource.
  "employees.salaryHistory",

  // ── /api/v1/leave ───────────────────────────────────────────────────
  /// `GET /api/v1/leave/applications` — org-wide leave applications
  /// with status / employee / date-overlap filters.
  "leave.applications",
  /// `GET /api/v1/employees/{id}/leave-balances` — per-type
  /// entitlement, accrued, used, carried and carry-expiry for a year.
  "leave.balances",

  // ── attendance + payroll reporting ──────────────────────────────────
  /// `GET /api/v1/attendance/summary` — per-employee worked-hours
  /// buckets + expected minutes for a date range. Aggregate, not a
  /// punch-record feed.
  "attendance.summary",
  /// `GET /api/v1/payroll-runs/{id}/readiness` — the same pre-submit
  /// statutory checklist the in-app submit guard runs.
  "payroll.readiness",

  /// `POST /api/v1/payroll-runs/{id}/adjustments` — add one one-off
  /// line item to an employee on a DRAFT run. `category` is required
  /// (no default) and `dryRun: true` returns the before/after/delta
  /// across gross, net, EPF, SOCSO, EIS and PCB without writing.
  "payroll.adjustments",

  /// `POST /api/v1/payroll-runs/{id}/submit` — DRAFT to
  /// PENDING_APPROVAL, naming an eligible submitter. Runs the same
  /// staleness / empty-run / prior-month / statutory-readiness guards
  /// as the in-app submit.
  "payroll.submit",
  /// `POST /api/v1/payroll-runs/{id}/reject` — PENDING_APPROVAL back to
  /// DRAFT with an optional reason. NOT the SUBMITTED-to-DRAFT revert,
  /// which cascades to later months and stays UI-only.
  "payroll.reject",

  /// `POST /api/v1/payroll-runs/{id}/revert` — SUBMITTED back to DRAFT,
  /// allowed ONLY when no later submitted month of the same year exists.
  /// Refuses with the blocking months rather than cascading them.
  "payroll.revert",

  // ── /api/v1/onboarding ──────────────────────────────────────────────
  /// `PUT /api/v1/onboarding` — the payroll-POLICY answers from a
  /// partner setup form in one call (working week, proration + HRDF,
  /// OT rates, project working hours, org-wide leave defaults +
  /// carry-forward). Resolves the layering caller-side ids would
  /// otherwise be needed for, and fans OT out to every non-archived
  /// policy. Company identity and banking stay on
  /// `PATCH /api/v1/payroll-settings`; per-policy and per-employee
  /// leave entitlements stay with CS.
  "onboarding.bulk",

  // ── /api/v1/leave-types ─────────────────────────────────────────────
  /// `GET /api/v1/leave-types` + `PATCH` of org-wide default day counts.
  /// Default days ONLY — accrual method, carry-forward and per-policy
  /// overrides stay with CS in the admin UI.
  "leave-types.defaultDays",
] as const

export type ApiFeature = (typeof API_FEATURE_CATALOG)[number]
