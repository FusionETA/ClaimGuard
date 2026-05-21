# Attendance module — context for Claude

This file is auto-loaded when Claude touches anything under
`modules/attendance/`. See the repo-wide `/CLAUDE.md`.

## What lives here

The attendance module covers clock-in / clock-out, working hours, OT
approvals, geofence checks, supervisor team views, and the org-wide roll
call. It depends on `XeroProject` (from the organisation module) for project
membership and geofence centres.

## Domain types

- `AttendanceStatus` — `ON_TIME | LATE | MISSING | CLOCKED_IN |
  CLOCKED_OUT | ON_LEAVE`.
- `ApprovalKind` — `CLOCK_IN | CLOCK_OUT | BREAK | OT`. The first three are
  retroactive corrections; the last is overtime authorisation.
- `OTSubtype` — `LATE_REPLACEMENT | OT_OFFSET | UNRESOLVED`. Drives how
  approved OT counts toward payroll.
- `EmployeeDetailData` — view-model for the per-employee attendance detail
  page. **Lives in `domain/models.ts`**, NOT in the React view file.

## Service / repo split

- `employee-attendance.service.ts` — clock-in/out + dashboard for the
  employee themselves. Geofence enforcement happens here:
  `enforceGeofenceForActiveRecord` blocks clock-out / break confirmation if
  the user is outside the project radius without a remark.
- `supervisor-attendance.service.ts` — team views for supervisors.
- `admin-attendance.service.ts` — org-wide roll call, org settings
  (working hours, OT rates), employee admin.
- `employee-detail-loader.ts` — the per-employee detail page builder
  (`loadEmployeeDetail(employeeId)`), used by both supervisor and admin
  flows. Returns `EmployeeDetailData`.
- `attendance.repository.ts` — all Prisma access, including the small
  user/org/project lookups (`getOrganizationIdForUser`,
  `getGeofenceRadiusForOrganization`, `getProjectGeoById`,
  `getTodayProjectId`, `getEmployeeProjectAssignments`) that the service
  uses to compose its operations.

## Geofence

- The org-wide radius lives at `Organization.geofenceRadiusMeters` (default
  via `lib/geo.DEFAULT_GEOFENCE_RADIUS_METERS`).
- The project's centre lives at `XeroProject.{latitude, longitude}`.
- `lib/geo.ts` exports `checkGeofence(coords, project, radius)`. Use it,
  don't compute distance inline.
- Off-site clock events require a remark — see the
  `OFF_SITE_REMARK_REQUIRED` constant in
  `employee-attendance.service.ts`.

## OT approvals

- An OT approval starts as `ApprovalRequest { kind: "OT", status: "PENDING" }`.
- Resolution has two paths: marked as `OT_OFFSET` (taken as time-off later),
  or as a `LATE_REPLACEMENT` (cancels out a previous late check-in).
- `slowOtApprovers` in the executive overview ranks reviewers by the
  average review-time over the lookback window. The query lives in
  `executive-overview.repository.ts` (in the claims module — yes it spans
  modules, that's intentional because the dashboard is unified).

## Don't

- Don't call `prisma.user.findUnique` / `prisma.organization.findUnique` from
  inside a service to look up an employee's org or geofence radius. Use
  `attendanceRepository.getOrganizationIdForUser` and
  `attendanceRepository.getGeofenceRadiusForOrganization`.
- Don't import `EmployeeDetailData` from the view component. It lives in
  `modules/attendance/domain/models.ts`.
- Don't reuse the legacy free-string `AttendanceRecord.project` for new
  features — prefer `projectId` (FK to `XeroProject`).
