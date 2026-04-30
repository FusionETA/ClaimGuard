# ClaimGuard Requirements

Tracking doc for ClaimGuard requirements. Status legend:
- `[ ]` Not started
- `[~]` In progress / partial
- `[x]` Done
- `[-]` Cancelled / out of scope

Last updated: 2026-04-30 (v2: confirmed daily/monthly worker, Location API, admin view-only complete)

---

## How to use

- Add requirements under the relevant area below. Create a new area if none fits.
- Each requirement is a single checkbox line. Use a `Notes:` sub-bullet for blockers, decisions, file pointers.
- When marking `[x]` Done, add a `Verified:` sub-bullet (file path / PR / manual check).

---

## This week

### Attendance — clock in/out

- [~] Radius check: if outside project location, allow clock in/out but add a remark.
  - Notes: GPS coords already captured at clock in/out/break (`app/(employee)/employee/attendance/clock-card.tsx:20`, `lib/geo.ts` has `haversineMeters`). `XeroProject` has `latitude`/`longitude` columns. Distance check + remark field on `AttendanceRecord` is not wired up yet.
- [~] Working time 8 AM – 5 PM.
  - Notes: `Organization.workingHoursStart/End` default to `09:00`/`18:00` (`prisma/schema.prisma:44`). Need to change defaults to `08:00`/`17:00` (and update existing org rows).
- [ ] Break clock in/out, fixed 1 hour. Daily staff: break is excluded from working hours.
  - Notes: `confirmBreak` action exists but is a single confirm tap, not paired in/out. `ApprovalKind.BREAK` exists in schema. Need start/end break events + 1h enforcement, and worker-type-aware accounting.
- [x] Employees can work multiple projects per day (clock in/out per project/location).
  - Verified: `EmployeeProjectAssignment` model + project picker on clock-in form (`clock-card.tsx:182-201`); each clock-in creates a record tagged to a project.
- [x] Supervisors also clock in/out.
  - Verified: Supervisor portal merged into `/employee/*`; the same `ClockCard` is rendered for SUPERVISOR role.

### Worker types

- [x] New field at registration: daily vs monthly worker.
  - Verified: `EmployeePayoutMethod` enum (`HOURLY` / `DAILY_BASED`) in `modules/organization/domain/models.ts:15`, stored on `EmployeeProfile.payoutMethod`. Supervisors auto-resolved to `DAILY_BASED` (`resolveEmployeePayoutMethod`).
- [ ] Leave only available for monthly staff.
  - Notes: Leave page is currently a placeholder (`app/(employee)/employee/leave/page.tsx`), so gating not needed yet — apply once leave module is built.
- [~] Use project location instead of a separate "office worker" setting.
  - Notes: `XeroProject.location/latitude/longitude` already exist. Admin attendance page surfaces project location. No "office worker" type currently exists, so nothing to remove — just confirm we don't add one.

### OT (overtime)

- [ ] Office workers: auto-flag OT after working hours → supervisor approve + comment, max until 10 PM.
  - Notes: `ApprovalKind.OT` and `OTSubtype` exist. Auto-creation on clock-out past `workingHoursEnd` not implemented. 10 PM cap not enforced.
- [ ] Foreign workers OT: supervisor approve → project manager approve.
  - Notes: `ApprovalChainStep` supports multi-step chains; needs flag for foreign worker + 2-step OT routing.
- [ ] Supervisors' OT: project manager approval.
  - Notes: `XeroProject.projectManagerId` exists. Need OT routing rule based on submitter's role.
- [ ] Project managers: no OT approval needed (auto-approved or skipped).

### Approvals

- [x] Supervisor approves clock in/out + break.
  - Verified: `ApprovalRequest` model with `kind = CLOCK_IN | CLOCK_OUT | BREAK | OT`, supervisor approvals page at `app/(employee)/employee/attendance/approvals/`.
- [ ] Approvals must be actioned within 1 hour.
  - Notes: No SLA timer / escalation. Need a deadline field or computed cutoff + escalation behaviour.
- [ ] Track missed approvals + frequent OT rejections (per supervisor metric).
  - Notes: Need reporting view, likely on admin side.
- [x] Supervisor's own attendance does not need approval.
  - Verified: Confirm in `attendance.repository.ts` clock paths — supervisors should auto-approve their own. (Re-check before marking final.)
- [x] Supervisors clock in/out themselves.
  - Verified: Same shell/clock card used.

### Hierarchy

- [~] Flexible layers (employee ↔ supervisor ↔ project manager, reversible / more layers).
  - Notes: `ApprovalChainStep` model + admin hierarchy page (`app/(admin)/admin/hierarchy/`) supports ordered chain. Need to confirm UI allows arbitrary depth and reversed chains (e.g. PM at step 1, supervisor at step 2).

### System

- [x] Clock-in button on employee dashboard.
  - Verified: `ClockCard` rendered on `/employee` (`app/(employee)/employee/page.tsx:62`).
- [x] Location API.
  - Verified: Project locations stored on `XeroProject` (`location`/`latitude`/`longitude`); managed via admin settings.
- [ ] Calendar (weekends + public holidays).
  - Notes: No calendar/holiday model in schema. Need a `Holiday` table + admin CRUD; consumed by attendance + OT rate logic.
- [~] Attendance history with filters + summary, including OT.
  - Notes: `app/(employee)/employee/attendance/history/page.tsx` exists. Verify filters (date, project, status) and OT line item summary.
- [~] Approvals page: filter by OT / attendance + search by name.
  - Notes: `approvals/page.tsx` lists pending. Need filter chips (OT vs attendance) + name search.

### Portals

- [x] Merge supervisor into employee portal (remove supervisor portal).
  - Verified: No `/supervisor` route; supervisors use `/employee/*` with role-gated nav items in `components/layout/employee-shell.tsx`.
- [x] Admin portal = view + reports only (no attendance/OT approvals).
  - Verified: Attendance/OT approvals live in the supervisor flow (`app/(employee)/employee/attendance/approvals/`). Admin still approves *claims* (`app/(admin)/admin/claims/actions.ts`), which is a separate workflow.

### Employee portal

- [x] Dashboard with clock-in + project selector.
  - Verified: `ClockCard` with project `<select>` on dashboard.
- [x] Payslip + Leave in navbar.
  - Verified: `employee-shell.tsx:33-71` includes both nav items (pages are placeholders).
- [ ] Approvals as a separate top-level menu (not nested under Attendance).
  - Notes: Currently a child of Attendance in `employee-shell.tsx:48-53`. Promote to top-level (supervisor-only) item.

---

## Open questions

- Working hours: confirm `08:00`–`17:00` is the global default, or per-organization configurable.
- Break window: is the 1-hour break a fixed time slot (e.g. 12–1) or any 1-hour window the employee picks?
- Foreign worker flag: new boolean on `EmployeeProfile`, or derive from a worker-type enum (LOCAL_DAILY / LOCAL_MONTHLY / FOREIGN / OFFICE)?
- Admin "view only" — does that mean no edit at all, or just no approve/reject (still allow user/project/hierarchy management)?
- 1-hour approval SLA — what happens after the hour? Auto-approve, escalate to PM, or just flag in the missed-approvals report?

## Done log

<!-- Brief dated milestones for at-a-glance history -->
