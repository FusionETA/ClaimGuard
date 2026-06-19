/**
 * Shared types for the Payroll Runs page's server actions. Per the
 * app/CLAUDE.md rule, "use server" files can ONLY export async
 * functions — type definitions live here and are imported by both the
 * actions.ts module and the client-side dialog component.
 */

export type YtdImportActionResult =
  | { ok: true; summary: YtdImportSummaryShape }
  | { ok: false; message: string }

/**
 * Mirror of `YtdImportSummary` in payroll-ytd-import.service.ts.
 * Re-declared here so the client dialog can import it without pulling
 * the `import "server-only"` service module into the browser bundle.
 * If the service's shape changes, update this in lockstep.
 */
export type YtdImportSummaryShape = {
  importedRunsCreated: number
  importedPayslips: number
  skippedUnknownEmployees: Array<{ name: string; idNumber: string }>
  skippedExistingPayslips: Array<{
    name: string
    year: number
    monthIdx: number
    reason: string
  }>
  skippedConflictingPeriods: Array<{
    year: number
    monthIdx: number
    reason: string
  }>
  parserWarnings: string[]
  parserErrors: string[]
}
