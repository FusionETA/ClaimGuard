# Deployment log

Per-release summary of **what changed**, **what schema moved**, and **what
needs to happen for the feature to actually work**. Not a step-by-step
runbook — reach for it before deploying to know whether a release needs
extra hand-holding beyond a plain `git pull + build + restart`.

Latest entries at the top.

---

## Multi-org employee (Phases 1a → 7)

**What changed.** A single `User` (same email + password) can now be an
active employee at multiple companies. On login they see a company
picker; a "Switch Company" button in the header lets them jump between
companies without logging out. Every employee-facing page (dashboard,
payslips, claims, leave, attendance, account) is scoped to the currently-
picked company only. Admin "Add Employee" detects an existing email
and links the user across a second company (keeping their existing
password).

**Schema changes.**
- `EmployeeProfile.userId` — dropped `@unique`, added compound
  `@@unique([userId, organizationId])`.
- `EmployeeProfile.organizationId` — new `String?` column, populated
  by the backfill.
- `EmployeeOrganization` — new join table (`userId`, `employeeProfileId`
  UNIQUE, `organizationId`, timestamps, `isArchived`).
- `User.employeeProfile` (singular) → `User.employeeProfiles` (plural,
  one-to-many).

**Deployment support.**
- Run **`npm run db:backfill-employee-org`** ONCE after `db:push`
  succeeds. Idempotent — populates `EmployeeProfile.organizationId`
  from `User.organizationId` and creates one `EmployeeOrganization`
  row per existing profile. Safe to re-run.
- If `db:push` complains about a duplicate FK on `EmployeeProfile_userId_fkey`,
  drop it manually then re-run `db:push`:
  `ALTER TABLE EmployeeProfile DROP FOREIGN KEY EmployeeProfile_userId_fkey;`
- Nothing else — after backfill, every existing single-org employee
  keeps their exact experience. Multi-org kicks in the moment an admin
  at Company B adds an existing employee's email; from that fire the
  picker appears at next login.

---

## Payroll summary PDF — SKBBK column + client-side download

**What changed.** Payroll summary PDF now includes a SKBBK column
between EIS and NET, and a "Total SKBBK payment" footer line
(hidden when total = 0). Also fixed the download-navigating-away bug
on the run-detail "Awaiting Approval" section — the button is now a
client-side blob download instead of a plain `<a href>`.

**Schema changes.** None.

**Deployment support.** None — code-only change, active as soon as
the build restarts.

---

## TP1 sub-categories + CP38 arrears (per LHDN 2026 MTD Spec)

**What changed.** Seven Borang TP1 sub-categories (life insurance,
medical insurance, PRS, serious-disease medical, lifestyle, sports
equipment, other) each with its LHDN 2026 annual cap. New `deduct_cp38`
adjustment feeds the CP39 CP38 column separately from standard PCB.

**Schema changes.**
- `Payslip.cp38` — new `Decimal(12, 2)` column, defaults to 0 on
  historical rows.

**Deployment support.** None — the column defaults to 0, so historical
payslips read cleanly. Admins just start using the new adjustment
categories on new runs.

---

## SKBBK / Skim Lindung 24 Jam (effective 1 Jun 2026)

**What changed.** New PERKESO scheme, employee-only 0.75% contribution
capped at RM 6,000 wage, in the same RM 350/year SOCSO+EIS PCB relief
bucket. Adds a payslip column, a Payroll Settings read-only card
showing the current phase, and a combined ASSIST 2.0 SOCSO+EIS+SKBBK
TXT export.

**Schema changes.**
- `Payslip.skbbkEmployee` — `Decimal(12, 2)`, default 0.
- `Payslip.skbbkWage` — `Decimal(12, 2)`, default 0.

**Deployment support.** None. Date-gated in code — [statutory-tables.ts:465](modules/payroll/domain/statutory-tables.ts:465)
returns 0 for any run whose period is before June 2026, regardless of
scheme. Phase 2 (1.0%) and Phase 3 (1.25%) will need a code change
(append a new entry to `SKBBK_PHASE_SCHEDULE`) when PERKESO publishes
the effective dates.

---

## Rehire TP3 auto-deduct (`prevIncludesPriorThisOrgPeriod`)

**What changed.** When an employee is rehired mid-year at the same org,
the payroll engine now auto-deducts the prior-this-org period's PCB from
the "previous employer" YTD figure supplied via TP3, so the same wages
aren't counted twice.

**Schema changes.**
- `PayrollProfile.prevIncludesPriorThisOrgPeriod` — new `Boolean`,
  default `false`.

**Deployment support.** None. Field defaults to `false`, so existing
profiles behave exactly as before. Admin ticks it manually for the
specific rehire.

---

## Saved portal credentials (AES-256 encrypted)

**What changed.** Payroll Settings gains a "Saved Portal Credentials"
tab where admins can store their KWSP and PERKESO login details for
faster monthly-return uploads. Credentials are AES-256-GCM-encrypted
at rest with a per-org master key.

**Schema changes.**
- New table `SavedPortalCredential` (`organizationId`, `portal` enum,
  `usernameEncrypted`, `passwordEncrypted`, `iv`, `authTag`).

**Deployment support.**
- Requires `PORTAL_CRED_MASTER_KEY_ENC_KEY` env var (32-byte
  hex-encoded) on the server. Rotate via **`npm run db:create-master-key`**
  ONCE per env — generates the key and writes it to `.env`. If unset,
  the credentials tab surfaces a "not configured" hint and refuses to
  save.

---

## CP38 arrears converter modal

**What changed.** Standalone modal accepting a multi-row table of
(employee, amount, month/year) rows and emitting a CP38 TXT file
formatted per LHDN spec.

**Schema changes.** None (pure UI + client-side text emitter).

**Deployment support.** None.

---

## PCB engine simplification (K1 rounding, CS truncation, Kt as band
diff)

**What changed.** Series of PCB math cleanups to align with Payroll
Panda's outputs at boundary cases:
- K1 ceils to whole ringgit (LHDN convention).
- Chargeable Income (CS) rounds to 2dp only at the sum stage.
- Kt derived as band difference so K1 reads as band-on-regular-only.
- SOCSO+EIS relief no longer 5-sen-ceils; fixed `trunc2` IEEE 754 bug.

**Schema changes.** None.

**Deployment support.** None. Purely domain math. Historical payslips
already snapshot their computation JSON, so recomputes affect NEW runs
only.

---

## Multi-org employee (Phases 1b callsite refactor)

**What changed.** 170 callsites across 21 files migrated from
`user.employeeProfile` (singular) to `user.employeeProfiles[0]` (plural)
+ new helpers `getPrimaryEmployeeProfile` / `getEmployeeProfileForOrg`.

**Schema changes.** Covered under Multi-org employee (Phase 1a) above.

**Deployment support.** Covered above — the backfill fills the new
plural relation from the old singular data before this code runs
against it.

---

## Payroll YTD import — two-step modal + always-on mapping

**What changed.** YTD import now surfaces a column-mapping panel on
every import (not just when unknown columns are detected), and the
review + confirm steps are split across two modal screens instead of
inline.

**Schema changes.** None.

**Deployment support.** None.

---

## Employee tab strip (Active vs Archived)

**What changed.** Payroll → Manage Employees page now has an
Active / Archived tab strip instead of showing everyone in one list.

**Schema changes.** None (reads existing `PayrollProfile.isArchived`).

**Deployment support.** None.

---

## Housekeeping

- `next-env.d.ts` and `tsconfig.tsbuildinfo` are Next.js/tsc scratch
  files. They rewrite themselves on `npm run build`; don't commit
  changes to them.
- The `scripts/` folder holds one-off diagnostics
  (`diagnose-ytd-duplicates`, `inspect-org-addons`,
  `build-pcb-walkthrough`). Not part of any deploy flow — invoke
  manually only when troubleshooting.
