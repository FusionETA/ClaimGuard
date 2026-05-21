# modules/policy/ — context for Claude

Per-employee feature gating. An `EmployeePolicy` row decides which
modules (claims, attendance, leave, payroll) an employee can see and
what limits apply to them.

## Layers

- **domain/models.ts** — `EmployeePolicyView`, `ModuleAccess`,
  `DEFAULT_MODULE_ACCESS`, and `moduleAccessForPolicy(policy)`. Pure —
  no DB.
- **application/guards.ts** — server-side guard helpers used by pages
  and actions to refuse a forbidden action with a typed result.
- **infrastructure/policy.repository.ts** — all Prisma access.

## Conventions

- Policy is **additive**: a missing policy row means "default access"
  (`DEFAULT_MODULE_ACCESS`), not "everything denied". The
  employee-dashboard pattern is:

  ```ts
  const policy = await policyRepository.findForUserId(session.userId)
  const moduleAccess = policy
    ? moduleAccessForPolicy(policy)
    : DEFAULT_MODULE_ACCESS
  ```

- Any new feature flag that admins want to gate per-employee belongs
  on `EmployeePolicy`, not on `User` or `Organization`.

## Don't

- Don't open-code the `policy ?? DEFAULT_MODULE_ACCESS` ternary in
  multiple places — call `moduleAccessForPolicy` or, better, a
  `getModuleAccessForUser(userId)` service helper.
- Don't read `prisma.employeePolicy.*` from a page — go through
  `policyRepository`.
- Don't store role-specific defaults here. Roles live on `User.role`;
  policy is per-employee overrides.
