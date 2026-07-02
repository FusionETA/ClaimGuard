# Deployment log

Per-release notes on **what changed**, **what schema moved**, and
**what has to happen on the server** for the feature to work.

Latest entries at the top.

---

## Multi-org employee (Phases 1a → 7)

**What changed.** A single `User` (same email + password) can now be an
active employee at multiple companies concurrently. On login they see a
company picker; a "Switch Company" button in the header lets them jump
between companies without logging out. Every employee-facing page
(dashboard, payslips, claims, leave, attendance, account) is scoped to
the currently-picked company only. Admin "Add Employee" detects an
existing email and links the user across a second company — keeping
their existing password. Cross-company password-change warning added to
the change-password dialog.

**Schema changes.**
- `EmployeeProfile.userId` — dropped `@unique`, replaced with compound
  `@@unique([userId, organizationId])`.
- `EmployeeProfile.organizationId` — new `String?` column, populated by
  the backfill.
- `EmployeeOrganization` — new join table
  (`userId`, `employeeProfileId` UNIQUE, `organizationId`, timestamps,
  `isArchived`).
- `User.employeeProfile` (singular) → `User.employeeProfiles` (plural,
  one-to-many).

**Deployment support.**
- Run **`npm run db:backfill-employee-org`** ONCE after `db:push`
  succeeds. Idempotent — populates `EmployeeProfile.organizationId`
  from `User.organizationId` and creates one `EmployeeOrganization`
  row per existing profile. Safe to re-run.
- If `db:push` errors with "duplicate foreign key" on
  `EmployeeProfile_userId_fkey`, drop it manually then re-run:
  `ALTER TABLE EmployeeProfile DROP FOREIGN KEY EmployeeProfile_userId_fkey;`
- After backfill, every existing single-org employee sees zero change.
  Multi-org kicks in the moment an admin at Company B adds an existing
  employee's email — the picker + switcher become available at that
  user's next login.
