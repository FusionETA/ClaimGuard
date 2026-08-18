import "server-only"

import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"

/**
 * Reference data a leave migration needs to resolve a foreign export
 * against this org: the employees (to turn a name into the email the
 * importer keys on) and the leave types (to turn a foreign policy name
 * into one of ours).
 *
 * Exists so the migration tools don't reach into the repository from a
 * route — see the layering rule in the repo-wide CLAUDE.md. Archived
 * leave types are included because the importer accepts them too, and
 * an org part-way through a migration may have archived a type it still
 * holds balances for.
 */
export async function getLeaveMigrationRefData(orgId: string): Promise<{
  employees: Array<{ name: string; email: string }>
  leaveTypes: Array<{ name: string; code: string }>
}> {
  const [employees, types] = await Promise.all([
    leaveRepository.listEmployeesForLeaveSettings(orgId),
    leaveRepository.listTypes(orgId, { includeArchived: true }),
  ])
  return {
    employees: employees.map((e) => ({ name: e.name, email: e.email })),
    leaveTypes: types.map((t) => ({ name: t.name, code: t.code })),
  }
}
