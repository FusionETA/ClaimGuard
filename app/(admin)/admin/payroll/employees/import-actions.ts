"use server"

import { revalidatePath } from "next/cache"
import { isAdminRole } from "@/lib/auth/types"
import { safeErrorMessage } from "@/lib/errors"

import { aiMapCsvColumns } from "@/lib/ai/csv-mapper-ai"
import { aiMapCsvValues } from "@/lib/ai/csv-value-mapper-ai"
import { getTargetSchemaForHeaders } from "@/lib/ai/csv-mapper"
import type {
  ColumnMapping,
  MappingMethod,
  SchemaField,
} from "@/lib/ai/csv-mapper"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import {
  bulkImportPayrollEmployees,
  extractCsvDistinctCategoricalValues,
  extractCsvPreview,
  extractCsvReferences,
  importMappedCsv,
  previewMappedCsv,
  resolveCsvReferences,
  type ImportResult,
  type MappedImportResult,
  type PreviewResult,
  type ReferenceResolutionResult,
} from "@/modules/payroll/application/services/payroll-import.service"
import { importDraftRepository } from "@/modules/payroll/infrastructure/import-draft.repository"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"
import { policyRepository } from "@/modules/policy/infrastructure/policy.repository"
import type {
  RowOverrides,
  ValueMap,
  ValueMappingResult,
} from "@/lib/ai/csv-value-mapper"

/**
 * Legacy single-shot import (template-shaped CSV). Kept for the
 * "use our template" path which doesn't need AI mapping.
 */
export type ImportActionResult =
  | { status: "success"; result: ImportResult }
  | { status: "error"; message: string }

export async function importPayrollEmployeesAction(
  _prev: ImportActionResult | null,
  formData: FormData,
): Promise<ImportActionResult> {
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return { status: "error", message: "No file uploaded." }
  }
  if (file.size === 0) {
    return { status: "error", message: "Uploaded file is empty." }
  }
  if (file.size > 5 * 1024 * 1024) {
    return {
      status: "error",
      message: "File too large (max 5 MB). Split into smaller batches.",
    }
  }
  const csv = await file.text()
  try {
    const result = await bulkImportPayrollEmployees({ csv })
    revalidatePath("/admin/payroll/employees")
    revalidatePath("/admin/hierarchy")
    return { status: "success", result }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Import failed."),
    }
  }
}

// ─── AI-mapped flow ──────────────────────────────────────────────────────

export type AiMapActionResult =
  | {
      status: "success"
      csvText: string
      headers: string[]
      mappings: ColumnMapping[]
      warnings: string[]
      /// Which tier produced the mapping — "groq" / "gemini" /
      /// "heuristic". UI surfaces this so admins know how much
      /// scrutiny each suggestion deserves.
      method: MappingMethod
      /// Schema returned for this specific file — includes any
      /// dynamic `childN.*` slots derived from the uploaded headers.
      targetSchema: SchemaField[]
      /// The list of dependent-child slot numbers detected in the
      /// file (e.g. [1, 2, 3]). The UI uses this to render the
      /// Spouse & Dependents tab with the right kid count.
      detectedChildSlots: number[]
    }
  | { status: "error"; message: string }

/**
 * Step 1: read the file, extract headers + samples, call GROQ for an
 * initial column mapping. The csvText is echoed back so the client
 * can hold it across the multi-step flow without re-uploading.
 */
export async function aiMapCsvAction(
  _prev: AiMapActionResult | null,
  formData: FormData,
): Promise<AiMapActionResult> {
  const file = formData.get("file")
  if (!(file instanceof File)) {
    return { status: "error", message: "No file uploaded." }
  }
  if (file.size === 0) {
    return { status: "error", message: "Uploaded file is empty." }
  }
  if (file.size > 5 * 1024 * 1024) {
    return {
      status: "error",
      message: "File too large (max 5 MB). Split into smaller batches.",
    }
  }

  const csvText = await file.text()
  const { headers, sampleRows } = extractCsvPreview(csvText)
  if (headers.length === 0) {
    return { status: "error", message: "CSV has no headers." }
  }

  let mappings: ColumnMapping[]
  let warnings: string[]
  let method: MappingMethod
  let detectedChildSlots: number[]
  try {
    // Internal chain: GROQ → Gemini → heuristic. Always returns
    // — heuristic mode requires no network. Errors only happen on
    // invariant violations, not on AI provider failures.
    const result = await aiMapCsvColumns(headers, sampleRows)
    mappings = result.mappings
    warnings = result.warnings
    method = result.method
    detectedChildSlots = result.detectedChildSlots
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Mapping failed."),
    }
  }

  return {
    status: "success",
    csvText,
    headers,
    mappings,
    warnings,
    method,
    targetSchema: getTargetSchemaForHeaders(headers),
    detectedChildSlots,
  }
}

// ─── AI value mapping (MAP_VALUES step) ─────────────────────────────────

export type AiMapValuesActionResult =
  | {
      status: "success"
      result: ValueMappingResult
      /**
       * The (target, sourceColumn, rawValues) trios the AI was asked
       * to map. Echoed back so the UI can render the value-mapping
       * step without re-walking the CSV on the client.
       */
      columns: Array<{
        target: string
        sourceColumn: string
        rawValues: string[]
      }>
    }
  | { status: "error"; message: string }

/**
 * Step 3 of the import wizard. After the admin confirms the column
 * mapping, we walk the CSV to collect distinct raw values for every
 * column whose target is categorical (enum/boolean), then ask the AI
 * to propose a canonical mapping for each. The wizard renders the
 * result as a dropdown grid the admin reviews before preview.
 *
 * Returns an empty mapping if the CSV has no categorical columns
 * mapped — the wizard skips the step entirely in that case.
 */
export async function aiMapCsvValuesAction(input: {
  csvText: string
  mapping: Record<string, string | null>
}): Promise<AiMapValuesActionResult> {
  try {
    const columns = extractCsvDistinctCategoricalValues({
      csv: input.csvText,
      mapping: input.mapping,
    })
    if (columns.length === 0) {
      return {
        status: "success",
        result: { suggestions: {}, warnings: [], method: "heuristic" },
        columns: [],
      }
    }
    const result = await aiMapCsvValues({ columns })
    return { status: "success", result, columns }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Value mapping failed."),
    }
  }
}

// ─── Preview ────────────────────────────────────────────────────────────

export type PreviewActionResult =
  | { status: "success"; result: PreviewResult }
  | { status: "error"; message: string }

export async function previewMappedCsvAction(input: {
  csvText: string
  mapping: Record<string, string | null>
  /** Optional admin-confirmed value-to-enum map from the wizard. */
  valueMap?: ValueMap
  /**
   * Optional per-row Policy/Project/Team/Layer overrides from the
   * preview step. Accepted here so callers can pass a single shape to
   * both preview and import actions.
   */
  rowOverrides?: RowOverrides
}): Promise<PreviewActionResult> {
  try {
    const result = await previewMappedCsv({
      csv: input.csvText,
      mapping: input.mapping,
      valueMap: input.valueMap,
      rowOverrides: input.rowOverrides,
    })
    return { status: "success", result }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Preview failed."),
    }
  }
}

// ─── Final commit ───────────────────────────────────────────────────────

export type MappedImportActionResult =
  | { status: "success"; result: MappedImportResult }
  | { status: "error"; message: string }

export async function importMappedCsvAction(input: {
  csvText: string
  mapping: Record<string, string | null>
  /** Optional admin-confirmed value-to-enum map from the wizard. */
  valueMap?: ValueMap
  /**
   * Optional per-row Policy/Project/Team/Layer overrides from the
   * preview step. Currently accepted but not yet consumed by the
   * importer — wired up in a later step of the wizard redesign.
   */
  rowOverrides?: RowOverrides
  /**
   * Per-row Leave Method overrides keyed by 0-based preview row
   * index. Rows without an entry implicitly use DEFAULT (resolved
   * policy/type chain). Rows with an entry get the typed overrides
   * applied on top of the default fallback.
   *
   * Updated (re-imported) employees are skipped — their existing
   * entitlements are preserved.
   */
  leaveSeedByRow?: Record<
    number,
    {
      days: Record<string, number>
      methods: Record<string, "LUMP_SUM" | "PRO_RATED">
    }
  >
}): Promise<MappedImportActionResult> {
  try {
    const result = await importMappedCsv({
      csv: input.csvText,
      mapping: input.mapping,
      valueMap: input.valueMap,
      rowOverrides: input.rowOverrides,
      leaveSeedByRow: input.leaveSeedByRow,
    })
    revalidatePath("/admin/payroll/employees")
    revalidatePath("/admin/hierarchy")
    return { status: "success", result }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Import failed."),
    }
  }
}

// ─── Picker options (preview step's per-row dropdowns) ─────────────────

export type ImportPickerOptions = {
  policies: Array<{ id: string; name: string }>
  projects: Array<{ id: string; name: string }>
  teams: Array<{
    id: string
    name: string
    projectId: string
    layerCount: number
  }>
  /// The org's seeded "default" Policy / Project / Team IDs. The
  /// preview pre-selects these on rows where the XLSX hierarchy cells
  /// are blank, so admins can hit Import without manually picking on
  /// every row. Any field is null when the matching default doesn't
  /// exist (legacy orgs from before the seeding flow shipped).
  defaults: {
    monthlyPolicyId: string | null
    hourlyPolicyId: string | null
    projectId: string | null
    teamId: string | null
    teamLayer: number
  }
}

export type ImportPickerOptionsActionResult =
  | { status: "success"; options: ImportPickerOptions }
  | { status: "error"; message: string }

/**
 * Returns every Policy / Project / Team the admin can pick from in
 * the preview step's per-row dropdowns. Called once when the preview
 * loads and re-called after each inline "+ Create new" so newly-
 * created records show up immediately.
 */
export async function listImportPickerOptionsAction(): Promise<ImportPickerOptionsActionResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No active organisation." }
  }
  try {
    const [policies, projects, teams, defaults] = await Promise.all([
      policyRepository.listForOrganization(organizationId),
      organizationRepository.getProjectsForOrganization(organizationId),
      organizationRepository.listTeamsForOrganization(organizationId),
      organizationRepository.getOrgImportDefaults(organizationId),
    ])
    return {
      status: "success",
      options: {
        policies: policies
          .filter((p) => !p.archived)
          .map((p) => ({ id: p.id, name: p.name })),
        projects: projects.map((p) => ({ id: p.id, name: p.name })),
        teams: teams.map((t) => ({
          id: t.id,
          name: t.name,
          projectId: t.projectId,
          layerCount: t.layerCount,
        })),
        defaults,
      },
    }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not load picker options."),
    }
  }
}

// ─── Resolve references (legacy — wizard no longer uses this) ──────────

export type ResolveReferencesActionResult =
  | { status: "success"; result: ReferenceResolutionResult }
  | { status: "error"; message: string }

/**
 * Server action backing the import wizard's RESOLVE step. Walks the
 * mapped CSV, extracts the policy / project / team names referenced,
 * then checks which already exist in the active org and which don't.
 * The UI uses the result to render the resolve list with inline
 * "Create" forms for missing items.
 */
export async function resolveReferencesAction(input: {
  csvText: string
  mapping: Record<string, string | null>
}): Promise<ResolveReferencesActionResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No active organisation." }
  }
  try {
    const references = extractCsvReferences({
      csv: input.csvText,
      mapping: input.mapping,
    })
    const result = await resolveCsvReferences({
      organizationId,
      references,
    })
    return { status: "success", result }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not resolve references."),
    }
  }
}

// ─── Inline-create shortcuts (used by the RESOLVE step) ──────────────────

export type CreatePolicyShortcutResult =
  | { status: "success"; id: string; name: string }
  | { status: "error"; message: string }

/**
 * Shortcut create-policy from the import wizard. Takes only the
 * policy name (+ minimum defaults baked in here) so the admin doesn't
 * have to leave the import to set up a policy from scratch. Admins
 * can refine the full policy fields later in Settings → Policies.
 */
export async function createImportPolicyAction(input: {
  name: string
}): Promise<CreatePolicyShortcutResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No active organisation." }
  }
  const name = input.name.trim()
  if (!name) return { status: "error", message: "Policy name is required." }

  try {
    const created = await policyRepository.create({
      organizationId,
      name,
      // Reasonable starting defaults — admin can tune per-policy in
      // Settings → Policies later. Mirrors what the admin UI's
      // "Create policy" form would emit if no checkboxes were ticked.
      canAccessAttendance: true,
      canAccessClaims: true,
      canAccessLeave: true,
      salaryType: "MONTHLY_BASED",
      otEnabled: false,
      otMethod: "CASH",
      requireGeofence: true,
      requireSelfie: false,
      temporary: false,
      otRateNormalDay: 1.5,
      otRateRestDay: 2.0,
      otRatePublicHoliday: 3.0,
      otRateRestDayInShift: 1.0,
      otRatePublicHolidayInShift: 2.0,
      otSalaryThreshold: null,
      otDailyThresholdMinutes: 0,
    })
    revalidatePath("/admin/settings")
    return { status: "success", id: created.id, name: created.name }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not create policy."),
    }
  }
}

export type CreateProjectShortcutResult =
  | { status: "success"; id: string; name: string }
  | { status: "error"; message: string }

/**
 * Shortcut create-project from the import wizard. Creates a manual
 * (non-Xero) project with just a name; admin can attach project
 * managers + coordinates later in Settings → Projects.
 */
export async function createImportProjectAction(input: {
  name: string
}): Promise<CreateProjectShortcutResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No active organisation." }
  }
  const name = input.name.trim()
  if (!name) return { status: "error", message: "Project name is required." }

  try {
    const created = await organizationRepository.createManualProject({
      organizationId,
      name,
    })
    revalidatePath("/admin/settings")
    return { status: "success", id: created.id, name: created.name }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not create project."),
    }
  }
}

export type CreateTeamShortcutResult =
  | { status: "success"; id: string; name: string; projectId: string }
  | { status: "error"; message: string }

/**
 * Shortcut create-team from the import wizard. The parent project
 * must already exist (the resolve step ensures admins create projects
 * before their teams). `layerCount` defaults to the max layer the
 * CSV references for this team — passed in by the caller so the
 * new team is wide enough for the import.
 */
export async function createImportTeamAction(input: {
  projectId: string
  name: string
  layerCount: number
}): Promise<CreateTeamShortcutResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No active organisation." }
  }
  const name = input.name.trim()
  if (!name) return { status: "error", message: "Team name is required." }
  const layerCount = Math.max(1, Math.min(10, Math.floor(input.layerCount)))

  try {
    const created = await organizationRepository.createTeam({
      organizationId,
      projectId: input.projectId,
      name,
      layerCount,
      // moduleConfig left at the repo's default — admin can refine
      // per-team approval modules in Settings → Teams later.
    })
    revalidatePath("/admin/settings")
    return { status: "success", id: created.id, name: created.name, projectId: created.projectId }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not create team."),
    }
  }
}

// ─── Resumable draft (one per admin per org) ─────────────────────────────

/**
 * The wizard's serialised state. Stored as a JSON blob in the
 * `EmployeeImportDraft.state` column. Loader is tolerant of missing
 * keys so older drafts survive a wizard code update — the wizard
 * resets any unsupported step / mapping field back to the upload
 * step rather than throwing.
 *
 * Kept loose on purpose: tightening the shape here would force a
 * migration every time we add a wizard field. The wizard validates
 * what it cares about on restore.
 */
export type ImportDraftPayload = {
  step?: string
  csvText?: string
  fileName?: string | null
  headers?: string[]
  mapping?: Record<string, string | null>
  aiSuggestion?: unknown
  targetSchema?: unknown
  valueMap?: ValueMap
  valueMapping?: unknown
  rowOverrides?: RowOverrides
  mapCategoryIndex?: number
  /** Row count from the latest preview, used in the resume panel. */
  rowCount?: number
}

export type ImportDraftSummary = {
  id: string
  fileName: string | null
  step: string
  rowCount: number
  updatedAt: string // ISO so the client can format with its locale
  state: ImportDraftPayload
}

export type SaveImportDraftActionResult =
  | { status: "success"; updatedAt: string }
  | { status: "error"; message: string }

/**
 * Upsert the current admin's draft for this org. Called by the
 * wizard's debounced auto-save and by the "Save & close" button.
 *
 * Quietly no-ops on the rare case of `payload.step === undefined`
 * (wizard hasn't been initialised yet) so the auto-save effect can
 * fire from a clean mount without writing garbage.
 */
export async function saveImportDraftAction(
  payload: ImportDraftPayload,
): Promise<SaveImportDraftActionResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No active organisation." }
  }
  if (!payload.step) {
    return { status: "error", message: "Nothing to save yet." }
  }
  try {
    const row = await importDraftRepository.upsert({
      userId: session.userId,
      organizationId,
      fileName: payload.fileName ?? null,
      step: payload.step,
      rowCount: payload.rowCount ?? 0,
      // Cast through unknown — the JSON column accepts any
      // serialisable value, and our payload contains primitive
      // arrays/objects only.
      state: payload as unknown as Parameters<
        typeof importDraftRepository.upsert
      >[0]["state"],
    })
    return { status: "success", updatedAt: row.updatedAt.toISOString() }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not save draft."),
    }
  }
}

export type GetImportDraftActionResult =
  | { status: "success"; draft: ImportDraftSummary | null }
  | { status: "error"; message: string }

/**
 * Fetch the admin's current draft (if any). Drafts older than 7 days
 * are lazily purged by the repo on read, so a stale draft never
 * reaches the UI.
 */
export async function getImportDraftAction(): Promise<GetImportDraftActionResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No active organisation." }
  }
  try {
    const row = await importDraftRepository.getForUser({
      userId: session.userId,
      organizationId,
    })
    if (!row) return { status: "success", draft: null }
    return {
      status: "success",
      draft: {
        id: row.id,
        fileName: row.fileName,
        step: row.step,
        rowCount: row.rowCount,
        updatedAt: row.updatedAt.toISOString(),
        // The JSON column round-trips through Prisma as `JsonValue`.
        // The wizard does its own per-key validation on restore.
        state: (row.state as unknown as ImportDraftPayload) ?? {},
      },
    }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not load draft."),
    }
  }
}

export type DiscardImportDraftActionResult =
  | { status: "success" }
  | { status: "error"; message: string }

/**
 * Discard the current admin's draft. Idempotent — succeeds even if
 * there's nothing to delete.
 */
export async function discardImportDraftAction(): Promise<DiscardImportDraftActionResult> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { status: "error", message: "Session expired. Please log in again." }
  }
  const organizationId = resolveActiveOrgId(session)
  if (!organizationId) {
    return { status: "error", message: "No active organisation." }
  }
  try {
    await importDraftRepository.deleteForUser({
      userId: session.userId,
      organizationId,
    })
    return { status: "success" }
  } catch (err) {
    return {
      status: "error",
      message: safeErrorMessage(err, "Could not discard draft."),
    }
  }
}
