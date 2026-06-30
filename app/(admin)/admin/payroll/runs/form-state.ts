/**
 * Shared types for the Payroll Runs page's server actions. Per the
 * app/CLAUDE.md rule, "use server" files can ONLY export async
 * functions — type definitions live here and are imported by both the
 * actions.ts module and the client-side dialog component.
 */

export type YtdImportActionResult =
  | { ok: true; summary: YtdImportSummaryShape }
  | { ok: false; message: string; conflictingMonths?: number[] }

/**
 * Mirror of `YtdImportSummary` in payroll-ytd-import.service.ts.
 * Re-declared here so the client dialog can import it without pulling
 * the `import "server-only"` service module into the browser bundle.
 * If the service's shape changes, update this in lockstep.
 */
export type YtdImportSummaryShape = {
  importedRunsCreated: number
  importedPayslips: number
  /// Count of IMPORTED runs that existed for this year BEFORE the
  /// upload and were wiped as part of the atomic replace. 0 on a
  /// first upload for the year.
  replacedRuns: number
  skippedUnknownEmployees: Array<{ name: string; idNumber: string }>
  parserWarnings: string[]
  parserErrors: string[]
}

/**
 * Server-action response for the year-context lookup the dialog calls
 * when the admin picks a year. Drives the inline warning banner +
 * fail-fast hint about months that would conflict with COMPUTED runs.
 */
export type YtdImportYearContext = {
  importedMonths: number[]
  computedMonths: number[]
}

/**
 * Client-friendly mirror of one column's classification (parser-side
 * `YtdImportColumnInfo`). Re-declared here so the dialog can import
 * without dragging the server-only parser into the browser bundle.
 */
export type YtdImportColumnInfoShape = {
  rawText: string
  normalized: string
  autoMatch:
    | { kind: "mandatory"; amountKey: string }
    | { kind: "optionalLegacy"; amountKey: string }
    | { kind: "standardCategory"; categoryCode: string }
    | { kind: "nameOrId" }
    | { kind: "unknown" }
}

export type YtdImportColumnsPreviewResult =
  | { ok: true; columns: YtdImportColumnInfoShape[] }
  | { ok: false; message: string }
