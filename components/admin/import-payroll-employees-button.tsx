"use client"

import {
  useActionState,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react"
import { Download, Sparkles, Upload } from "lucide-react"

import {
  aiMapCsvAction,
  aiMapCsvValuesAction,
  createImportPolicyAction,
  createImportProjectAction,
  createImportTeamAction,
  discardImportDraftAction,
  getImportDraftAction,
  importMappedCsvAction,
  listImportPickerOptionsAction,
  previewMappedCsvAction,
  saveImportDraftAction,
  type AiMapActionResult,
  type AiMapValuesActionResult,
  type ImportDraftPayload,
  type ImportDraftSummary,
  type ImportPickerOptions,
} from "@/app/(admin)/admin/payroll/employees/import-actions"
import {
  FIELD_CATEGORIES,
  type ColumnMapping,
  type FieldCategory,
  type SchemaField,
} from "@/lib/ai/csv-mapper"
import {
  CATEGORICAL_TARGETS,
  type RowOverrides,
  type ValueMap,
} from "@/lib/ai/csv-value-mapper"
import type {
  MappedImportResult,
  PreviewResult,
} from "@/modules/payroll/application/services/payroll-import.service"
import type { AddEmployeeLeaveType } from "@/modules/payroll/application/services/payroll-profile.service"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/admin/payroll-form-controls"

/// Per-policy default rows passed down so the Leave Method UI can
/// (in future) pre-fill per-policy custom values. Today bulk import
/// uses per-batch customs only, so we read this only as the type
/// of the parent's `policyDefaults` prop.
export type BulkImportPolicyDefault = {
  policyId: string
  leaveTypeId: string
  defaultDays: number
  accrualMethod: "LUMP_SUM" | "PRO_RATED" | null
}

/// Per-row entry in the wizard's `leaveSeedByRow` state.
/// - No entry → ORG_DEFAULT (seed from leave-type defaults, skip policy layer)
/// - `method: "DEFAULT"` → per-policy (seed from policy/type chain)
/// - `method: "CUSTOM"` (or absent) + days/methods → custom values
type PerRowLeaveSeed =
  | { method: "DEFAULT" }
  | { method?: "CUSTOM"; days: Record<string, number>; methods: Record<string, "LUMP_SUM" | "PRO_RATED"> }

/// Seed a fresh PerRowLeaveSeed using each leave type's own
/// defaultDays + accrualMethod. Bulk imports don't have a single
/// policy picked up front (the policy comes from the CSV per row),
/// so we can't pre-fill from a policy override. Admins start from
/// the type defaults and tweak in the dialog.
function blankLeaveSeed(leaveTypes: AddEmployeeLeaveType[]): PerRowLeaveSeed {
  const days: Record<string, number> = {}
  const methods: Record<string, "LUMP_SUM" | "PRO_RATED"> = {}
  for (const t of leaveTypes) {
    days[t.id] = t.defaultDays
    methods[t.id] = t.accrualMethod
  }
  return { method: "CUSTOM", days, methods }
}

/// Count how many overrides in a CUSTOM PerRowLeaveSeed differ from the
/// type defaults. Used to label the row badge "Custom (N)".
function customOverrideCount(
  seed: Extract<PerRowLeaveSeed, { days: Record<string, number> }>,
  leaveTypes: AddEmployeeLeaveType[],
): number {
  let count = 0
  for (const t of leaveTypes) {
    const days = seed.days[t.id]
    const method = seed.methods[t.id]
    if (days !== undefined && days !== t.defaultDays) count += 1
    else if (method !== undefined && method !== t.accrualMethod) count += 1
  }
  return count
}
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

/**
 * Multi-step CSV import dialog with AI column mapping.
 *
 * Steps:
 *   1. UPLOAD   — admin picks a CSV file. Server reads it, calls
 *                  GROQ for a column-mapping suggestion.
 *   2. MAP      — admin reviews mappings one CATEGORY at a time
 *                  (Identity & Employment, Personal & Contact,
 *                  Statutory & Payroll, etc.). AI suggestion is
 *                  pre-selected; confidence badges flag uncertain
 *                  picks. Required fields must all be mapped before
 *                  the admin can leave their category.
 *   3. VALUES   — admin reviews the AI's value-to-enum suggestions
 *                  for every categorical column (e.g. "Single" →
 *                  SINGLE, "Yes" → TRUE). Skipped when the CSV has
 *                  no categorical columns mapped.
 *   4. PREVIEW  — first 5 normalised rows shown so admin can sanity-
 *                  check. Per-row pickers let the admin pick or
 *                  inline-create the Policy / Project / Team / Layer
 *                  for each row.
 *   5. DONE     — final counts after commit.
 *
 * The MAP step uses a sub-stepper that visits each visible category
 * in order. A category is "visible" if it contains a required field
 * OR if at least one source column is currently mapped to one of its
 * fields. Pure-optional categories with no mapped columns auto-skip
 * (e.g. Spouse & Dependents when the CSV has no spouse columns).
 */
type Step = "resume" | "upload" | "map" | "values" | "preview" | "done"

/**
 * Auto-save debounce in ms. The wizard fires
 * `saveImportDraftAction` this long after the last state change.
 * Shorter feels responsive; longer reduces DB churn. 1000ms is the
 * usual sweet spot for form-state auto-save.
 */
const DRAFT_AUTOSAVE_DEBOUNCE_MS = 1_000

/**
 * Required fields that the admin can supply via the preview step's
 * per-row picker INSTEAD of mapping a CSV column. These reference DB
 * records (policies / projects / teams), and the preview's
 * `CreatableSelect` supports inline "+ Create new" for each. The
 * column-mapping step does not block on these being unmapped.
 *
 * The schema still flags them `required` so the schema documents the
 * desired end-state on EmployeeProfile, but the wizard's gating
 * differentiates between "required from CSV column" (everything else)
 * and "required somewhere — CSV column OR preview picker".
 */
const PREVIEW_PICKABLE_REQUIRED = new Set([
  "policyName",
  "projectCode",
  "teamCode",
  "teamLayer",
])

export function ImportPayrollEmployeesButton({
  leaveTypes,
  policyDefaults,
}: {
  leaveTypes: AddEmployeeLeaveType[]
  policyDefaults: BulkImportPolicyDefault[]
}) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>("upload")
  /**
   * Per-row Leave Method choice. Keyed by 0-based preview row index.
   * Rows without an entry get `{ method: "DEFAULT" }` on commit (each
   * created employee inherits from policy/type chain).
   *
   * Switching a row to Custom opens `PerRowLeaveDialog`, which saves
   * a `{ method: "CUSTOM", overrides }` entry here. Switching back to
   * Default drops the entry.
   */
  const [leaveSeedByRow, setLeaveSeedByRow] = useState<
    Record<number, PerRowLeaveSeed>
  >({})
  /// 0-based preview row index currently being edited via the
  /// PerRowLeaveDialog. null = dialog closed.
  const [leaveDialogRow, setLeaveDialogRow] = useState<number | null>(null)
  const [csvText, setCsvText] = useState<string>("")
  const [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [aiSuggestion, setAiSuggestion] = useState<ColumnMapping[]>([])
  const [targetSchema, setTargetSchema] = useState<SchemaField[]>([])
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [finalResult, setFinalResult] = useState<MappedImportResult | null>(
    null,
  )
  /**
   * Per-row Policy / Project / Team / Layer overrides set by the
   * admin in the preview step. Keyed by 0-based preview row index.
   * Threaded into `importMappedCsvAction` so the importer can use the
   * IDs directly and skip the CSV-name lookup for overridden rows.
   */
  const [rowOverrides, setRowOverrides] = useState<RowOverrides>({})
  /**
   * Cached picker dropdown options for the preview step. Loaded once
   * on entry and re-loaded after each inline "+ Create new" so freshly
   * created Policies / Projects / Teams show up in subsequent rows.
   */
  const [pickerOptions, setPickerOptions] = useState<ImportPickerOptions | null>(
    null,
  )

  /**
   * Friendly file name from the most recent upload — surfaced in the
   * "Continue draft" panel and saved with each draft.
   */
  const [fileName, setFileName] = useState<string | null>(null)
  /**
   * The draft fetched on dialog open. Drives the "resume" step's
   * Continue / Discard panel. `null` once we've checked and there's
   * nothing to resume; `undefined` until the first fetch completes.
   */
  const [draft, setDraft] = useState<ImportDraftSummary | null | undefined>(
    undefined,
  )
  /**
   * Auto-save state for the small status pill rendered in the dialog
   * header — gives admins confidence their work is being preserved
   * without being noisy.
   */
  const [draftStatus, setDraftStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle")
  /**
   * When true, the auto-save effect is allowed to fire. Switched on
   * after the first non-upload step is entered so we don't write an
   * empty draft just from opening the dialog.
   */
  const [autoSaveArmed, setAutoSaveArmed] = useState(false)
  /**
   * Admin-confirmed value-to-enum map from the wizard's MAP_VALUES
   * step. Keyed by target field key, then by the raw CSV value. The
   * value is either a canonical enum string (e.g. "TRUE", "MARRIED") or
   * `null` meaning "leave the cell blank — don't import this value".
   */
  const [valueMap, setValueMap] = useState<ValueMap>({})
  /**
   * Result returned from `aiMapCsvValuesAction` — the AI's per-rawValue
   * suggestion plus the source columns the wizard should render in the
   * MAP_VALUES step. `columns` is empty when the CSV has no categorical
   * columns mapped; in that case the wizard skips the step entirely.
   */
  const [valueMapping, setValueMapping] = useState<
    Extract<AiMapValuesActionResult, { status: "success" }> | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  /**
   * Index into `visibleMapCategories` for the MAP step. Reset to 0
   * whenever we re-enter the MAP step. Advancing past the last visible
   * category transitions to the next top-level step.
   */
  const [mapCategoryIndex, setMapCategoryIndex] = useState(0)

  /**
   * Categories visible in the MAP sub-stepper.
   *
   * A category is shown if:
   *   - it contains ANY required field — including preview-pickable
   *     ones — so the admin always knows what fields the category
   *     covers and has the option to map a CSV column even when not
   *     forced to, OR
   *   - at least one source column is currently mapped to one of its
   *     fields.
   *
   * Pure-optional categories with no mapped columns drop out so
   * single-purpose CSVs (e.g. personal info only) don't make the
   * admin click "Next" through empty Spouse / Bank screens. The
   * Hierarchy category stays visible regardless because its required
   * fields (policy/project/team/layer) are still relevant — they're
   * just preview-pickable rather than CSV-required.
   */
  const visibleMapCategories = useMemo<FieldCategory[]>(() => {
    if (targetSchema.length === 0) return []
    const mappedCategories = new Set<FieldCategory>()
    for (const [, targetKey] of Object.entries(mapping)) {
      if (!targetKey) continue
      const f = targetSchema.find((s) => s.key === targetKey)
      if (f) mappedCategories.add(f.category)
    }
    return FIELD_CATEGORIES.filter((cat) => {
      const fieldsInCat = targetSchema.filter((f) => f.category === cat)
      if (fieldsInCat.some((f) => f.required)) return true
      return mappedCategories.has(cat)
    })
  }, [targetSchema, mapping])

  /** Clamp the active sub-step if visibility changes (e.g. last
   * mapped column for a category was unmapped, so the category just
   * disappeared). Otherwise leave it alone. */
  useEffect(() => {
    if (step !== "map") return
    if (mapCategoryIndex >= visibleMapCategories.length) {
      setMapCategoryIndex(Math.max(0, visibleMapCategories.length - 1))
    }
  }, [step, mapCategoryIndex, visibleMapCategories.length])

  /**
   * Dialog open: fetch any existing draft. If one exists, show the
   * resume panel before the admin sees the Upload step. If not, fall
   * through to Upload as before.
   *
   * Re-runs whenever the dialog opens — closing + reopening picks up
   * any draft created since (e.g. from another tab).
   */
  useEffect(() => {
    if (!open) {
      setDraft(undefined)
      setAutoSaveArmed(false)
      return
    }
    let cancelled = false
    void (async () => {
      const result = await getImportDraftAction()
      if (cancelled) return
      if (result.status === "success") {
        if (result.draft) {
          setDraft(result.draft)
          setStep("resume")
        } else {
          setDraft(null)
        }
      } else {
        // Fetch failure shouldn't block the wizard — just log and
        // let the admin start fresh.
        console.error("[import-wizard] draft fetch failed:", result.message)
        setDraft(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  /**
   * Build the current wizard state as a draft payload. Used by the
   * auto-save effect and the "Save & close" button. Memoised so the
   * auto-save effect only re-fires when something meaningful changes.
   */
  const draftPayload = useMemo<ImportDraftPayload>(
    () => ({
      step,
      csvText,
      fileName,
      headers,
      mapping,
      aiSuggestion,
      targetSchema,
      valueMap,
      valueMapping,
      rowOverrides,
      mapCategoryIndex,
      rowCount: preview?.total ?? 0,
    }),
    [
      step,
      csvText,
      fileName,
      headers,
      mapping,
      aiSuggestion,
      targetSchema,
      valueMap,
      valueMapping,
      rowOverrides,
      mapCategoryIndex,
      preview,
    ],
  )

  /**
   * Debounced auto-save. Fires `DRAFT_AUTOSAVE_DEBOUNCE_MS` after the
   * last change to the draft payload. Skipped when the wizard hasn't
   * been "armed" yet (i.e. admin is still on Upload or Resume) so we
   * don't write a useless empty draft on dialog open.
   *
   * The "saved" / "saving" badge in the dialog header is driven by
   * the same effect — keeps the indicator honest about what's
   * actually been persisted.
   */
  useEffect(() => {
    if (!open) return
    if (!autoSaveArmed) return
    if (step === "resume" || step === "done") return
    // Only auto-save after we've at least loaded a CSV; otherwise
    // there's nothing meaningful to persist.
    if (!csvText) return

    setDraftStatus("saving")
    const timer = setTimeout(async () => {
      const result = await saveImportDraftAction(draftPayload)
      if (result.status === "success") {
        setDraftStatus("saved")
      } else {
        setDraftStatus("error")
        console.error("[import-wizard] auto-save failed:", result.message)
      }
    }, DRAFT_AUTOSAVE_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [open, autoSaveArmed, step, csvText, draftPayload])

  /**
   * Resume from the saved draft. Restores every saved field, jumps
   * the wizard to the saved step, and arms auto-save so future edits
   * keep being persisted.
   *
   * Picker options + preview rows aren't saved (they're re-derived
   * from the CSV at preview time) — if the admin resumed at the
   * preview step we re-fetch picker options + re-run preview.
   *
   * IMPORTANT: React state updates aren't synchronous, so the saved
   * CSV / mapping / valueMap aren't visible to closures called in
   * this same render tick. Any server action that needs the restored
   * values must be called with them explicitly (not via the wizard
   * state variables). That's why the preview path below passes the
   * draft's values into a dedicated loader instead of calling
   * `goToPreview()` after `setCsvText(...)`.
   */
  function continueFromDraft() {
    if (!draft) return
    const s = draft.state ?? {}
    const restoredCsvText = s.csvText ?? ""
    const restoredMapping = s.mapping ?? {}
    const restoredValueMap = s.valueMap ?? {}
    const restoredRowOverrides = s.rowOverrides ?? {}

    setCsvText(restoredCsvText)
    setFileName(s.fileName ?? null)
    setHeaders(s.headers ?? [])
    setMapping(restoredMapping)
    // aiSuggestion/targetSchema are typed loosely on purpose so older
    // drafts survive — we trust the wizard to handle missing pieces
    // by treating them as fresh state for the affected step.
    setAiSuggestion(
      (s.aiSuggestion as typeof aiSuggestion | undefined) ?? [],
    )
    setTargetSchema(
      (s.targetSchema as typeof targetSchema | undefined) ?? [],
    )
    setValueMap(restoredValueMap)
    setValueMapping(
      (s.valueMapping as typeof valueMapping | undefined) ?? null,
    )
    setRowOverrides(restoredRowOverrides)
    setMapCategoryIndex(s.mapCategoryIndex ?? 0)
    setAutoSaveArmed(true)

    const savedStep = (s.step ?? "upload") as Step
    if (savedStep === "preview") {
      // Pass the freshly-restored values directly — `goToPreview`
      // would read stale closures here.
      loadPreviewWith({
        csvText: restoredCsvText,
        mapping: restoredMapping,
        valueMap: restoredValueMap,
        // Don't reset overrides on resume — admin's saved picks
        // need to survive.
        keepRowOverrides: true,
      })
    } else {
      setStep(savedStep)
    }
  }

  /**
   * Underlying preview loader used by both `goToPreview` (live state)
   * and `continueFromDraft` (restored state). Accepts the inputs
   * explicitly so callers can avoid stale-closure bugs.
   */
  function loadPreviewWith(input: {
    csvText: string
    mapping: Record<string, string | null>
    valueMap: ValueMap
    /**
     * When true, the existing `rowOverrides` state is preserved —
     * the resume path uses this so saved per-row picks survive.
     * When false (default for live-state preview), we reset
     * overrides because re-entering preview after editing mapping
     * could have made the saved IDs stale.
     */
    keepRowOverrides?: boolean
  }) {
    setError(null)
    startTransition(async () => {
      const [previewResult, pickerResult] = await Promise.all([
        previewMappedCsvAction({
          csvText: input.csvText,
          mapping: input.mapping,
          valueMap: input.valueMap,
        }),
        listImportPickerOptionsAction(),
      ])
      if (previewResult.status !== "success") {
        setError(previewResult.message)
        return
      }
      if (pickerResult.status !== "success") {
        setError(pickerResult.message)
        return
      }
      setPreview(previewResult.result)
      setPickerOptions(pickerResult.options)
      if (!input.keepRowOverrides) {
        setRowOverrides({})
      }
      setStep("preview")
    })
  }

  /**
   * Discard the current draft and start a fresh import.
   */
  async function discardDraftAndStart() {
    setError(null)
    const result = await discardImportDraftAction()
    if (result.status === "error") {
      setError(result.message)
      return
    }
    setDraft(null)
    reset()
    // `reset()` puts us back on "upload"; that's exactly where we
    // want to be after discarding.
  }

  /**
   * "Save & close" — explicit save followed by closing the dialog.
   * Used as a belt-and-braces alongside the debounced auto-save in
   * case the admin closes the tab before the debounce fires.
   */
  async function saveAndClose() {
    setError(null)
    setDraftStatus("saving")
    const result = await saveImportDraftAction(draftPayload)
    if (result.status === "success") {
      setDraftStatus("saved")
      close()
    } else {
      setDraftStatus("error")
      setError(result.message)
    }
  }

  const [, mapAction, mapPending] = useActionState<
    AiMapActionResult | null,
    FormData
  >(async (_prev, formData) => {
    setError(null)
    // Capture the file name from the uploaded File before the action
    // consumes it — surfaced in the "Continue draft" panel so admins
    // can recognise which import the draft belongs to.
    const fileInput = formData.get("file")
    if (fileInput instanceof File) setFileName(fileInput.name)
    const result = await aiMapCsvAction(_prev, formData)
    if (result.status === "success") {
      setCsvText(result.csvText)
      setHeaders(result.headers)
      setAiSuggestion(result.mappings)
      setTargetSchema(result.targetSchema)
      // Seed the mapping with AI's picks.
      const seed: Record<string, string | null> = {}
      for (const m of result.mappings) {
        seed[m.sourceColumn] = m.ourField
      }
      setMapping(seed)
      setMapCategoryIndex(0)
      setStep("map")
      // Arm auto-save now that we have meaningful state to persist.
      setAutoSaveArmed(true)
    } else {
      setError(result.message)
    }
    return result
  }, null)

  function reset() {
    setStep("upload")
    setCsvText("")
    setHeaders([])
    setMapping({})
    setAiSuggestion([])
    setTargetSchema([])
    setPreview(null)
    setFinalResult(null)
    setError(null)
    setMapCategoryIndex(0)
    setValueMap({})
    setValueMapping(null)
    setRowOverrides({})
    setPickerOptions(null)
    setFileName(null)
    setDraftStatus("idle")
    setAutoSaveArmed(false)
  }

  function close() {
    setOpen(false)
    // Defer reset so the closing animation has clean state.
    setTimeout(reset, 200)
  }

  /**
   * After the admin finishes per-category column mapping, call the
   * AI value mapper for every column whose target is categorical.
   * If the CSV has no categorical columns mapped, skip the step and
   * jump straight to preview.
   */
  function goToValues() {
    setError(null)
    startTransition(async () => {
      const result = await aiMapCsvValuesAction({ csvText, mapping })
      if (result.status !== "success") {
        setError(result.message)
        return
      }
      if (result.columns.length === 0) {
        // Nothing to map — fall through to preview without showing
        // an empty Map-values screen.
        setValueMapping(null)
        setValueMap({})
        goToPreview()
        return
      }
      // Seed the admin-confirmed value map with the AI's picks.
      const seed: ValueMap = {}
      for (const col of result.columns) {
        const perTarget = result.result.suggestions[col.target] ?? {}
        const seededTarget: Record<string, string | null> = {}
        for (const raw of col.rawValues) {
          const suggestion = perTarget[raw]
          seededTarget[raw] = suggestion?.value ?? null
        }
        seed[col.target] = seededTarget
      }
      setValueMapping(result)
      setValueMap(seed)
      setStep("values")
    })
  }

  /**
   * Enter the preview step. Fetches both the normalised preview rows
   * AND the picker options in parallel so the per-row dropdowns are
   * ready immediately. Resets `rowOverrides` because picker IDs
   * could be stale if the admin went back and changed mapping.
   */
  function goToPreview() {
    loadPreviewWith({ csvText, mapping, valueMap })
  }

  /**
   * Re-fetch picker options without re-running the preview. Called
   * after the admin uses an inline "+ Create new" so newly-created
   * records show up in the dropdowns immediately.
   */
  function refreshPickerOptions() {
    startTransition(async () => {
      const result = await listImportPickerOptionsAction()
      if (result.status === "success") setPickerOptions(result.options)
      else setError(result.message)
    })
  }

  function commit() {
    setError(null)
    startTransition(async () => {
      const result = await importMappedCsvAction({
        csvText,
        mapping,
        valueMap,
        rowOverrides,
        // Send the per-row Leave Method map. Only rows the admin
        // actively customised are included; the rest get DEFAULT on
        // the server side. Skip empty maps to keep the payload small.
        leaveSeedByRow:
          Object.keys(leaveSeedByRow).length > 0 ? leaveSeedByRow : undefined,
      })
      if (result.status === "success") {
        setFinalResult(result.result)
        setStep("done")
        // Import landed — wipe the draft so the admin doesn't get a
        // stale "Continue draft" prompt next time they open the
        // wizard. Best-effort: a failure here just means the resume
        // panel will appear on next open, where the admin can
        // discard manually.
        setAutoSaveArmed(false)
        void discardImportDraftAction().catch(() => {
          /* swallow — best-effort */
        })
      } else {
        setError(result.message)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true)
        else close()
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="gap-2">
          <Upload className="h-4 w-4" />
          Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent
        className={cn(
          // Default narrow size for upload / mapping. The preview step
          // has a wide table (every CSV column plus the canonical-value
          // picker) so widen the dialog for that step only — admins
          // were having to horizontal-scroll each row to verify.
          step === "preview" ? "max-w-7xl w-[95vw]" : "sm:max-w-3xl",
        )}
      >
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DialogTitle className="text-xl">
              Bulk import employees
            </DialogTitle>
            {step !== "resume" && step !== "upload" && step !== "done" ? (
              <DraftStatusPill status={draftStatus} />
            ) : null}
          </div>
          <DialogDescription>
            Upload any CSV — our AI maps your columns to our schema.
            Required fields marked <span className="font-mono">*</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto max-h-[calc(85vh-10rem)]">
          {/* While we're checking for a draft on dialog open, hide
              both the stepper and the body so admins don't see the
              Upload step flash for a frame before being replaced by
              the Resume panel. `draft === undefined` is the
              "checking" state; `null` means we've checked and there's
              no draft. */}
          {draft === undefined ? (
            <DraftLoadingBody />
          ) : (
            <>
              {step !== "resume" && <Stepper step={step} />}

              {error && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              {step === "resume" && draft ? (
                <ResumeStep
                  draft={draft}
                  onContinue={continueFromDraft}
                  onDiscard={discardDraftAndStart}
                  busy={isPending}
                />
              ) : null}

              {step === "upload" && (
                <UploadStep action={mapAction} pending={mapPending} />
              )}

          {step === "map" && visibleMapCategories.length > 0 && (
            <CategoryMapStep
              category={
                visibleMapCategories[
                  Math.min(
                    mapCategoryIndex,
                    visibleMapCategories.length - 1,
                  )
                ]
              }
              categoryIndex={Math.min(
                mapCategoryIndex,
                visibleMapCategories.length - 1,
              )}
              visibleCategories={visibleMapCategories}
              headers={headers}
              mapping={mapping}
              aiSuggestion={aiSuggestion}
              targetSchema={targetSchema}
              onChange={(source, field) =>
                setMapping((m) => ({ ...m, [source]: field }))
              }
              onBack={() => {
                if (mapCategoryIndex > 0) {
                  setMapCategoryIndex((i) => i - 1)
                } else {
                  reset()
                }
              }}
              onNext={() => {
                if (mapCategoryIndex < visibleMapCategories.length - 1) {
                  setMapCategoryIndex((i) => i + 1)
                } else {
                  goToValues()
                }
              }}
              onJumpToCategory={(idx) => setMapCategoryIndex(idx)}
              busy={isPending}
            />
          )}

          {step === "values" && valueMapping && (
            <ValuesStep
              valueMapping={valueMapping}
              valueMap={valueMap}
              onChange={(target, raw, canonical) =>
                setValueMap((prev) => ({
                  ...prev,
                  [target]: {
                    ...(prev[target] ?? {}),
                    [raw]: canonical,
                  },
                }))
              }
              onBack={() => setStep("map")}
              onNext={goToPreview}
              busy={isPending}
            />
          )}

          {step === "preview" && preview && pickerOptions && (
            <PreviewStep
              preview={preview}
              pickerOptions={pickerOptions}
              rowOverrides={rowOverrides}
              leaveTypes={leaveTypes}
              leaveSeedByRow={leaveSeedByRow}
              onRowLeaveMethodChange={(rowIndex, method) => {
                if (method === "ORG_DEFAULT") {
                  // No entry = ORG_DEFAULT (server default).
                  setLeaveSeedByRow((prev) => {
                    const next = { ...prev }
                    delete next[rowIndex]
                    return next
                  })
                  return
                }
                if (method === "DEFAULT") {
                  // Per-policy: store a method marker; no custom days needed.
                  setLeaveSeedByRow((prev) => ({
                    ...prev,
                    [rowIndex]: { method: "DEFAULT" },
                  }))
                  return
                }
                // CUSTOM: init blank if not already custom, then open the dialog.
                setLeaveSeedByRow((prev) => {
                  const existing = prev[rowIndex]
                  if (existing && existing.method !== "DEFAULT") return prev
                  return { ...prev, [rowIndex]: blankLeaveSeed(leaveTypes) }
                })
                setLeaveDialogRow(rowIndex)
              }}
              onEditRowLeave={(rowIndex) => setLeaveDialogRow(rowIndex)}
              onOverrideChange={(rowIndex, patch) =>
                setRowOverrides((prev) => {
                  const next = { ...prev }
                  const merged = { ...(prev[rowIndex] ?? {}), ...patch }
                  // Drop the entry if every override key is now empty
                  // so the importer falls back to the CSV-name lookup
                  // for that row.
                  const isEmpty =
                    merged.policyId == null &&
                    merged.projectId == null &&
                    merged.teamId == null &&
                    merged.teamLayer == null
                  if (isEmpty) {
                    delete next[rowIndex]
                  } else {
                    next[rowIndex] = merged
                  }
                  return next
                })
              }
              onRefreshPickers={refreshPickerOptions}
              onBack={() => {
                // Skip back over the empty Values step if it was
                // auto-skipped on the way in.
                if (valueMapping && valueMapping.columns.length > 0) {
                  setStep("values")
                } else {
                  setStep("map")
                }
              }}
              onCommit={commit}
              busy={isPending}
            />
          )}

          {step === "done" && finalResult && (
            <DoneStep result={finalResult} onClose={close} />
          )}

          {/* Save-and-close lives outside the per-step footers so it
              shows on every active step (map / values / preview) and
              never on Upload, Resume or Done. The auto-save effect
              keeps the draft current already; this is a belt-and-
              braces option for admins who want an explicit save
              moment before leaving. */}
          {(step === "map" || step === "values" || step === "preview") && (
            <div className="flex justify-center pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={saveAndClose}
                disabled={isPending || draftStatus === "saving"}
              >
                {draftStatus === "saving" ? "Saving…" : "Save draft & close"}
              </Button>
            </div>
          )}
            </>
          )}
        </div>
      </DialogContent>
      {/* Per-row Leave Method dialog. Rendered as a sibling of the
          wizard's DialogContent so its overlay/z-index management
          stays clean (nesting a Radix Dialog inside another can
          cause focus-trap fights). */}
      <PerRowLeaveDialog
        rowIndex={leaveDialogRow}
        previewRow={
          leaveDialogRow !== null && preview
            ? preview.preview[leaveDialogRow] ?? null
            : null
        }
        leaveTypes={leaveTypes}
        seed={(() => {
          if (leaveDialogRow === null) return null
          const s = leaveSeedByRow[leaveDialogRow]
          if (!s || s.method === "DEFAULT") return null
          return s
        })()}
        onSave={(rowIndex, nextSeed) => {
          setLeaveSeedByRow((prev) => ({ ...prev, [rowIndex]: nextSeed }))
          setLeaveDialogRow(null)
        }}
        onCancel={() => setLeaveDialogRow(null)}
      />
    </Dialog>
  )
}

/**
 * Lightweight skeleton shown in the dialog body while we're checking
 * for an existing draft on open. Replaces the first-frame flash of
 * the Upload step before the fetch resolves.
 */
function DraftLoadingBody() {
  return (
    <div className="space-y-3 py-6">
      <div className="mx-auto h-2 w-32 animate-pulse rounded-full bg-muted" />
      <p className="text-center text-xs text-muted-foreground">
        Loading…
      </p>
    </div>
  )
}

// ─── Stepper ────────────────────────────────────────────────────────────

function Stepper({ step }: { step: Step }) {
  const items: Array<{ key: Step; label: string }> = [
    { key: "upload", label: "Upload" },
    { key: "map", label: "Review mapping" },
    { key: "values", label: "Map values" },
    { key: "preview", label: "Preview" },
    { key: "done", label: "Done" },
  ]
  const order = items.findIndex((i) => i.key === step)
  return (
    <div className="flex items-center gap-2 text-xs">
      {items.map((item, i) => {
        const isActive = item.key === step
        const isDone = i < order
        return (
          <div key={item.key} className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : isDone
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {i + 1}
            </span>
            <span
              className={cn(
                isActive
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {item.label}
            </span>
            {i < items.length - 1 && (
              <span className="text-muted-foreground">→</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Step 1: upload ─────────────────────────────────────────────────────

function UploadStep({
  action,
  pending,
}: {
  action: (formData: FormData) => void
  pending: boolean
}) {
  return (
    <>
      <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <p className="font-medium text-foreground">
              Use our template (optional)
            </p>
            <p className="text-xs text-muted-foreground">
              Styled Excel template — friendly headers, dropdowns, and an
              example row. Required columns marked{" "}
              <span className="font-mono">*</span>.
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="gap-2">
            <a href="/admin/payroll/employees/import-template" download>
              <Download className="h-4 w-4" />
              Download Excel template
            </a>
          </Button>
        </div>
      </div>

      <form action={action} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="csv-file" className="text-xs">
            CSV or Excel file
          </Label>
          <input
            id="csv-file"
            type="file"
            name="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            className="block w-full rounded-md border border-border bg-card px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary"
            aria-describedby="csv-file-leading-zero-tip"
          />
          <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
            <Sparkles className="h-3 w-3" />
            AI will read your column names and map them to our schema.
            You&apos;ll review before any data is imported.
          </p>
          <p
            id="csv-file-leading-zero-tip"
            className="text-[11px] leading-5 text-amber-700 dark:text-amber-300"
          >
            <span className="font-semibold">Tip:</span> Excel auto-strips
            leading zeros from ID columns when saving as CSV (e.g.{" "}
            <span className="font-mono">000701070280</span> becomes{" "}
            <span className="font-mono">701070280</span>). Format IC,
            SOCSO, SSFW, and postcode columns as <span className="font-mono">Text</span>{" "}
            in Excel <em>before</em> saving. We auto-pad these specific
            fields back to their canonical length as a safety net, but
            other ID-shaped fields (EPF, bank account, phone) we can&apos;t
            recover.
          </p>
        </div>
        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={pending}>
            {pending ? "Reading…" : "Next: review mapping"}
          </Button>
        </div>
      </form>
    </>
  )
}

// ─── Resume step (shown when a draft exists on dialog open) ─────────────

/**
 * Friendly labels for the saved step. Surfaced in the "Continue
 * draft" card so the admin can see where they left off without
 * opening the wizard.
 */
const STEP_DISPLAY: Record<Step, string> = {
  resume: "Resume",
  upload: "Upload",
  map: "Review mapping",
  values: "Map values",
  preview: "Preview",
  done: "Done",
}

/**
 * Format a draft's `updatedAt` into a friendly relative time like
 * "5 minutes ago", "2 hours ago", "yesterday". Falls back to the
 * locale date string for anything older than a week — but in practice
 * the 7-day TTL on the server means we never reach the fallback.
 */
function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const diffMs = Date.now() - t
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`
  return new Date(t).toLocaleDateString()
}

function ResumeStep({
  draft,
  onContinue,
  onDiscard,
  busy,
}: {
  draft: ImportDraftSummary
  onContinue: () => void
  onDiscard: () => void
  busy: boolean
}) {
  const stepLabel =
    STEP_DISPLAY[(draft.step as Step) ?? "upload"] ?? draft.step
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
        <p className="text-base font-semibold text-foreground">
          You have an unfinished import
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Last edited {formatRelativeTime(draft.updatedAt)}
          {draft.fileName ? (
            <>
              {" "}from <span className="font-medium text-foreground">{draft.fileName}</span>
            </>
          ) : null}
          . You were on <span className="font-medium text-foreground">{stepLabel}</span>
          {draft.rowCount > 0 ? (
            <>
              {" "}with{" "}
              <span className="font-medium text-foreground">
                {draft.rowCount} row{draft.rowCount === 1 ? "" : "s"}
              </span>
            </>
          ) : null}
          .
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onDiscard}
          disabled={busy}
        >
          Discard & start fresh
        </Button>
        <Button type="button" onClick={onContinue} disabled={busy}>
          Continue draft
        </Button>
      </div>
    </div>
  )
}

/**
 * Tiny status pill that sits in the dialog header so admins know
 * their auto-save is happening. Hidden on the upload + resume + done
 * steps where it'd be misleading.
 */
function DraftStatusPill({
  status,
}: {
  status: "idle" | "saving" | "saved" | "error"
}) {
  if (status === "idle") return null
  // After the early-return above, status is narrowed to non-idle.
  const map: Record<
    "saving" | "saved" | "error",
    { label: string; cls: string }
  > = {
    saving: {
      label: "Saving draft…",
      cls: "bg-muted text-muted-foreground",
    },
    saved: {
      label: "Draft saved",
      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    },
    error: {
      label: "Draft save failed",
      cls: "bg-destructive/10 text-destructive",
    },
  }
  const { label, cls } = map[status]
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        cls,
      )}
    >
      {label}
    </span>
  )
}

// ─── Step 2: map review (per-category sub-stepper) ──────────────────────

/**
 * Map step for a single category. The wizard rotates through every
 * `visibleCategories` entry in order; the sub-stepper at the top shows
 * the admin where they are. "Next" advances to the next category, or
 * transitions to the next top-level step on the last one.
 *
 * The body shows two sections:
 *   1. Required fields in this category that are NOT yet mapped — an
 *      admin can pick a source column for each from a dropdown. "Next"
 *      is blocked until every required field has a source column.
 *   2. Source columns whose current target lives in this category —
 *      the admin can override or unmap, same as the old single-screen
 *      MapStep, but scoped to this category only.
 *
 * Both sections sit inside one table so the admin sees the full
 * picture for the current category in one place.
 */
function CategoryMapStep({
  category,
  categoryIndex,
  visibleCategories,
  headers,
  mapping,
  aiSuggestion,
  targetSchema,
  onChange,
  onBack,
  onNext,
  onJumpToCategory,
  busy,
}: {
  category: FieldCategory
  categoryIndex: number
  visibleCategories: FieldCategory[]
  headers: string[]
  mapping: Record<string, string | null>
  aiSuggestion: ColumnMapping[]
  targetSchema: SchemaField[]
  onChange: (source: string, field: string | null) => void
  onBack: () => void
  onNext: () => void
  onJumpToCategory: (index: number) => void
  busy: boolean
}) {
  const suggestionMap = useMemo(
    () => new Map(aiSuggestion.map((s) => [s.sourceColumn, s])),
    [aiSuggestion],
  )

  /** Fields in this category, in schema order. */
  const fieldsInCategory = useMemo(
    () => targetSchema.filter((f) => f.category === category),
    [targetSchema, category],
  )

  /** Source columns whose CURRENT mapping target lives in this category. */
  const sourcesInCategory = useMemo(() => {
    const set = new Set<string>()
    for (const [source, targetKey] of Object.entries(mapping)) {
      if (!targetKey) continue
      const f = targetSchema.find((s) => s.key === targetKey)
      if (f && f.category === category) set.add(source)
    }
    return headers.filter((h) => set.has(h))
  }, [headers, mapping, targetSchema, category])

  /**
   * Required fields in this category that are NOT yet mapped — and
   * NOT in `PREVIEW_PICKABLE_REQUIRED`. The preview-pickable required
   * fields (Hierarchy: policy / project / team / layer) are excluded
   * because the admin can supply them per-row in the preview picker;
   * we don't force a CSV column for them.
   */
  const unmappedRequired = useMemo(() => {
    const usedTargets = new Set(
      Object.values(mapping).filter((t): t is string => t != null && t !== ""),
    )
    return fieldsInCategory.filter(
      (f) =>
        f.required &&
        !PREVIEW_PICKABLE_REQUIRED.has(f.key) &&
        !usedTargets.has(f.key),
    )
  }, [fieldsInCategory, mapping])

  /**
   * Preview-pickable required fields in this category that are
   * UNmapped. Rendered as an informational banner — the admin can
   * either pick a CSV column for them here OR leave them empty and
   * set them per-row in the preview picker.
   */
  const unmappedPickableRequired = useMemo(() => {
    const usedTargets = new Set(
      Object.values(mapping).filter((t): t is string => t != null && t !== ""),
    )
    return fieldsInCategory.filter(
      (f) =>
        f.required &&
        PREVIEW_PICKABLE_REQUIRED.has(f.key) &&
        !usedTargets.has(f.key),
    )
  }, [fieldsInCategory, mapping])

  const isLast = categoryIndex >= visibleCategories.length - 1
  const isFirst = categoryIndex === 0
  const blockedReason =
    unmappedRequired.length > 0
      ? `Map all required fields in ${category} first: ${unmappedRequired
          .map((f) => f.key)
          .join(", ")}`
      : null

  return (
    <>
      <CategorySubStepper
        active={categoryIndex}
        categories={visibleCategories}
        onJump={onJumpToCategory}
      />

      <p className="text-sm text-muted-foreground">
        Mapping <span className="font-medium text-foreground">{category}</span>{" "}
        ({categoryIndex + 1} of {visibleCategories.length}). Required fields are
        marked <span className="font-mono">*</span>.
      </p>

      {unmappedRequired.length > 0 ? (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 text-xs dark:border-amber-700/40 dark:bg-amber-950/20">
          <p className="font-medium text-foreground">
            {unmappedRequired.length} required field
            {unmappedRequired.length === 1 ? "" : "s"} in this category{" "}
            {unmappedRequired.length === 1 ? "is" : "are"} not yet mapped:
          </p>
          <ul className="mt-1 space-y-2">
            {unmappedRequired.map((f) => (
              <RequiredFieldRow
                key={f.key}
                field={f}
                headers={headers}
                mapping={mapping}
                onPick={(source) => onChange(source, f.key)}
              />
            ))}
          </ul>
        </div>
      ) : null}

      {unmappedPickableRequired.length > 0 ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs">
          <p className="font-medium text-foreground">
            {unmappedPickableRequired.length} field
            {unmappedPickableRequired.length === 1 ? "" : "s"} can be left
            empty here — you&apos;ll set{" "}
            {unmappedPickableRequired.length === 1 ? "it" : "them"} per row
            in the preview step.
          </p>
          <ul className="mt-1 space-y-2">
            {unmappedPickableRequired.map((f) => (
              <RequiredFieldRow
                key={f.key}
                field={f}
                headers={headers}
                mapping={mapping}
                onPick={(source) => onChange(source, f.key)}
              />
            ))}
          </ul>
        </div>
      ) : null}

      <ScrollArea className="overflow-x-auto rounded-lg border border-border/60">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Your column</th>
              <th className="px-3 py-2 text-left font-medium">Mapped to</th>
              <th className="px-3 py-2 text-left font-medium w-24">
                Confidence
              </th>
            </tr>
          </thead>
          <tbody>
            {sourcesInCategory.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-3 py-6 text-center text-xs text-muted-foreground"
                >
                  No source columns are mapped to <strong>{category}</strong>{" "}
                  yet. Pick source columns for any required fields above to
                  populate this table.
                </td>
              </tr>
            ) : (
              sourcesInCategory.map((h, index) => {
                const suggestion = suggestionMap.get(h)
                const current = mapping[h] ?? ""
                return (
                  <tr
                    key={`${h || "blank"}-${index}`}
                    className="border-t border-border/60"
                  >
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium text-foreground">
                        {h || "(blank column)"}
                      </div>
                      {suggestion?.reason && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {suggestion.reason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <FieldSelect
                        value={current}
                        fields={targetSchema}
                        onChange={(field) => onChange(h, field)}
                      />
                    </td>
                    <td className="px-3 py-2 align-top">
                      {suggestion ? (
                        <span
                          className={cn(
                            "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                            suggestion.confidence === "high"
                              ? "border-emerald-300/60 bg-emerald-50 text-emerald-700"
                              : suggestion.confidence === "medium"
                                ? "border-amber-300/60 bg-amber-50 text-amber-700"
                                : "border-destructive/40 bg-destructive/10 text-destructive",
                          )}
                        >
                          {suggestion.confidence}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </ScrollArea>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          {isFirst ? "Back to upload" : "Previous category"}
        </Button>
        <div className="flex items-center gap-2">
          {blockedReason ? (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {blockedReason}
            </span>
          ) : null}
          <Button
            type="button"
            onClick={onNext}
            disabled={busy || unmappedRequired.length > 0}
          >
            {busy
              ? "Loading…"
              : isLast
                ? "Next: map values"
                : "Next category"}
          </Button>
        </div>
      </div>
    </>
  )
}

/**
 * The mini-stepper that sits above the category form. Categories
 * already visited are marked done; future categories are clickable
 * shortcuts for admins who want to jump around. Required-field gating
 * is enforced in the parent — clicking ahead doesn't bypass it because
 * the "Next" button there stays disabled.
 */
function CategorySubStepper({
  active,
  categories,
  onJump,
}: {
  active: number
  categories: FieldCategory[]
  onJump: (index: number) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/50 bg-muted/30 p-1.5 text-[11px]">
      {categories.map((cat, i) => {
        const isActive = i === active
        const isDone = i < active
        return (
          <button
            key={cat}
            type="button"
            onClick={() => onJump(i)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 transition-colors",
              isActive
                ? "bg-background font-medium text-foreground shadow-sm"
                : isDone
                  ? "text-emerald-700 hover:bg-background/70 dark:text-emerald-300"
                  : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : isDone
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {isDone ? "✓" : i + 1}
            </span>
            <span className="whitespace-nowrap">{cat}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Row in the "required fields not yet mapped" banner. Renders a tight
 * source-column dropdown next to the missing field so the admin can
 * pick which CSV column to wire it to without leaving the screen.
 *
 * The dropdown splits options into "Unmapped" (cheapest to wire) and
 * "Currently mapped to another field" (selectable but warns it'll
 * steal from another target). When every source column is already
 * mapped — common when the AI does its job well — we show a friendly
 * note instead of a dropdown of useless picks, pointing the admin at
 * the preview picker if the field is preview-pickable.
 */
function RequiredFieldRow({
  field,
  headers,
  mapping,
  onPick,
}: {
  field: SchemaField
  headers: string[]
  mapping: Record<string, string | null>
  onPick: (source: string) => void
}) {
  const { unmapped, taken } = useMemo(() => {
    const u: string[] = []
    const t: Array<{ h: string; target: string }> = []
    for (const h of headers) {
      const m = mapping[h]
      if (!m) u.push(h)
      else t.push({ h, target: m })
    }
    return { unmapped: u, taken: t }
  }, [headers, mapping])

  const isPickable = PREVIEW_PICKABLE_REQUIRED.has(field.key)
  const noUnmapped = unmapped.length === 0

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300/50 bg-amber-100/30 px-2.5 py-1.5">
      <div className="min-w-0">
        <span className="text-sm font-medium text-foreground">
          {field.key}
          {field.required ? (
            <span className="ml-1 text-primary" aria-hidden="true">
              *
            </span>
          ) : null}
        </span>
        <span className="ml-2 text-[11px] text-muted-foreground">
          {field.description}
        </span>
      </div>
      <Select
        value=""
        onValueChange={(next) => {
          if (next && next !== "__noop") onPick(next)
        }}
      >
        <SelectTrigger className="h-8 max-w-[18rem] rounded-md border-border/70 bg-background px-2 text-xs shadow-none">
          <SelectValue placeholder="Pick a source column…" />
        </SelectTrigger>
        <SelectContent>
          {headers.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No source columns in this CSV.
            </div>
          ) : (
            <>
              {noUnmapped ? (
                <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                  All {taken.length} CSV column{taken.length === 1 ? "" : "s"}{" "}
                  are already mapped to other fields.{" "}
                  {isPickable
                    ? "You can leave this empty and set it per row in the preview step."
                    : "Pick one below to steal it from its current target."}
                </div>
              ) : (
                <>
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Unmapped ({unmapped.length})
                  </div>
                  {unmapped.map((h) => (
                    <SelectItem key={h} value={h}>
                      <span className="truncate">{h || "(blank)"}</span>
                    </SelectItem>
                  ))}
                </>
              )}
              {taken.length > 0 ? (
                <>
                  {!noUnmapped ? <SelectSeparator /> : null}
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Already mapped — picking will reassign ({taken.length})
                  </div>
                  {taken.map(({ h, target }) => (
                    <SelectItem key={h} value={h}>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{h || "(blank)"}</span>
                        <span className="text-[10px] uppercase tracking-wide text-amber-700">
                          → {target}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </>
              ) : null}
            </>
          )}
        </SelectContent>
      </Select>
    </li>
  )
}

function FieldSelect({
  value,
  fields,
  onChange,
}: {
  value: string
  fields: SchemaField[]
  onChange: (field: string | null) => void
}) {
  const selectedField = fields.find((f) => f.key === value)
  const [activeCategory, setActiveCategory] = useState<FieldCategory>(
    selectedField?.category ?? "Identity & Employment",
  )
  const fieldsByCategory = useMemo(() => {
    const grouped = new Map<FieldCategory, SchemaField[]>()
    for (const cat of FIELD_CATEGORIES) grouped.set(cat, [])
    for (const field of fields) {
      grouped.get(field.category)?.push(field)
    }
    return grouped
  }, [fields])
  const activeFields = fieldsByCategory.get(activeCategory) ?? []

  useEffect(() => {
    if (selectedField) setActiveCategory(selectedField.category)
  }, [selectedField])

  return (
    <Select
      value={value || "__skip"}
      onValueChange={(next) => onChange(next === "__skip" ? null : next)}
    >
      <SelectTrigger className="h-9 max-w-xs rounded-lg border-border/70 bg-background px-3 text-sm shadow-none sm:h-9">
        <SelectValue placeholder="Skip column" />
      </SelectTrigger>
      <SelectContent className="w-[min(34rem,var(--radix-select-trigger-width))] min-w-[26rem] p-0">
        <div
          className="sticky top-0 z-10 border-b border-border/60 bg-card/95 p-2 backdrop-blur-xl"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="flex gap-1 overflow-x-auto rounded-lg bg-muted/40 p-1 nice-scrollbar">
            {FIELD_CATEGORIES.map((category) => {
              const active = category === activeCategory
              return (
                <button
                  key={category}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setActiveCategory(category)
                  }}
                  className={cn(
                    "inline-flex shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors",
                    active
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                  )}
                >
                  {category}
                </button>
              )
            })}
          </div>
        </div>
        <SelectItem value="__skip">Skip column</SelectItem>
        {activeFields.map((f) => (
          <SelectItem key={f.key} value={f.key}>
            <span className="flex min-w-0 items-center gap-1.5">
              {f.required && (
                <span className="text-primary" aria-hidden="true">
                  *
                </span>
              )}
              <span className="truncate">{f.key}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ─── Step 3: map values ─────────────────────────────────────────────────

/**
 * Map-values step. For every column whose admin-confirmed target is
 * an enum or boolean, we collect distinct raw values and ask the AI
 * to suggest a canonical mapping. The admin reviews each suggestion
 * in a dropdown grid.
 *
 * The Next button is blocked when any raw value is `null` (unmapped),
 * forcing the admin to explicitly pick "Leave blank" if they don't
 * want to import that value. Low-confidence picks get an amber pill;
 * the admin should look at those before clicking through.
 */
function ValuesStep({
  valueMapping,
  valueMap,
  onChange,
  onBack,
  onNext,
  busy,
}: {
  valueMapping: Extract<AiMapValuesActionResult, { status: "success" }>
  valueMap: ValueMap
  onChange: (target: string, raw: string, canonical: string | null) => void
  onBack: () => void
  onNext: () => void
  busy: boolean
}) {
  const totalValues = valueMapping.columns.reduce(
    (n, c) => n + c.rawValues.length,
    0,
  )
  const methodLabel =
    valueMapping.result.method === "groq"
      ? "AI (GROQ)"
      : valueMapping.result.method === "gemini"
        ? "AI (Gemini)"
        : "Heuristic synonym match"

  // Count low-confidence suggestions still on their AI default — admin
  // really should review those before continuing.
  const needsReview = useMemo(() => {
    let count = 0
    for (const col of valueMapping.columns) {
      const perTarget = valueMapping.result.suggestions[col.target] ?? {}
      for (const raw of col.rawValues) {
        const suggestion = perTarget[raw]
        if (!suggestion) continue
        if (suggestion.confidence !== "low") continue
        const current = valueMap[col.target]?.[raw] ?? null
        // Only flag if the admin hasn't already overridden the value.
        if (current === (suggestion.value ?? null)) count += 1
      }
    }
    return count
  }, [valueMapping, valueMap])

  return (
    <>
      <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
        Found <span className="font-semibold text-foreground">{totalValues}</span>{" "}
        distinct value{totalValues === 1 ? "" : "s"} across{" "}
        <span className="font-semibold text-foreground">
          {valueMapping.columns.length}
        </span>{" "}
        enum / boolean column
        {valueMapping.columns.length === 1 ? "" : "s"}. Suggestions are from{" "}
        <span className="font-medium text-foreground">{methodLabel}</span>.
        Review each one and pick <em>Leave blank</em> if a value shouldn&apos;t
        be imported.
      </div>

      {valueMapping.result.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 text-xs dark:border-amber-700/40 dark:bg-amber-950/20">
          <p className="font-medium text-foreground">Heads up</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {valueMapping.result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-4">
        {valueMapping.columns.map((col) => (
          <ValueMappingCard
            key={`${col.target}::${col.sourceColumn}`}
            target={col.target}
            sourceColumn={col.sourceColumn}
            rawValues={col.rawValues}
            suggestions={valueMapping.result.suggestions[col.target] ?? {}}
            valueMap={valueMap}
            onChange={onChange}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-2">
          {needsReview > 0 ? (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {needsReview} low-confidence pick
              {needsReview === 1 ? "" : "s"} — review before continuing.
            </span>
          ) : null}
          <Button type="button" onClick={onNext} disabled={busy}>
            {busy ? "Loading…" : "Next: preview"}
          </Button>
        </div>
      </div>
    </>
  )
}

/**
 * One card per (target, sourceColumn) pair. Lists every distinct raw
 * value with a dropdown of the target's canonical values. The dropdown
 * also offers "Leave blank" so the admin can opt a particular raw
 * value out of the import.
 */
function ValueMappingCard({
  target,
  sourceColumn,
  rawValues,
  suggestions,
  valueMap,
  onChange,
}: {
  target: string
  sourceColumn: string
  rawValues: string[]
  suggestions: Record<
    string,
    { value: string | null; confidence: "high" | "medium" | "low"; reason: string }
  >
  valueMap: ValueMap
  onChange: (target: string, raw: string, canonical: string | null) => void
}) {
  const spec = CATEGORICAL_TARGETS[target]
  if (!spec) return null
  const allowed = spec.values

  return (
    <div className="rounded-xl border border-border/60 bg-card/94 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">
          {sourceColumn}{" "}
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            → {target}
          </span>
        </p>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {spec.kind}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{spec.description}</p>

      <table className="mt-3 w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-medium">Your CSV value</th>
            <th className="py-1 text-left font-medium">Maps to</th>
            <th className="py-1 text-left font-medium w-24">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {rawValues.map((raw) => {
            const suggestion = suggestions[raw]
            const current = valueMap[target]?.[raw] ?? null
            return (
              <tr key={raw} className="border-t border-border/40">
                <td className="py-1.5 align-top">
                  <span className="font-medium text-foreground">{raw}</span>
                </td>
                <td className="py-1.5 align-top">
                  <Select
                    value={current ?? "__blank"}
                    onValueChange={(next) =>
                      onChange(target, raw, next === "__blank" ? null : next)
                    }
                  >
                    <SelectTrigger className="h-8 max-w-[14rem] rounded-md border-border/70 bg-background px-2 text-xs shadow-none">
                      <SelectValue placeholder="Leave blank" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__blank">
                        <span className="italic text-muted-foreground">
                          Leave blank
                        </span>
                      </SelectItem>
                      {allowed.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {suggestion?.reason && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {suggestion.reason}
                    </p>
                  )}
                </td>
                <td className="py-1.5 align-top">
                  {suggestion ? (
                    <span
                      className={cn(
                        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                        suggestion.confidence === "high"
                          ? "border-emerald-300/60 bg-emerald-50 text-emerald-700"
                          : suggestion.confidence === "medium"
                            ? "border-amber-300/60 bg-amber-50 text-amber-700"
                            : "border-destructive/40 bg-destructive/10 text-destructive",
                      )}
                    >
                      {suggestion.confidence}
                    </span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Step 4: preview ───────────────────────────────────────────────────

/**
 * Hierarchy reference columns that the per-row picker controls.
 * Listed in pinned-column-first order so the picker columns sit at the
 * end of the table for easy scanning.
 */
const HIERARCHY_COLUMNS = ["policyName", "projectCode", "teamCode", "teamLayer"]

function PreviewStep({
  preview,
  pickerOptions,
  rowOverrides,
  leaveTypes,
  leaveSeedByRow,
  onRowLeaveMethodChange,
  onEditRowLeave,
  onOverrideChange,
  onRefreshPickers,
  onBack,
  onCommit,
  busy,
}: {
  preview: PreviewResult
  pickerOptions: ImportPickerOptions
  rowOverrides: RowOverrides
  leaveTypes: AddEmployeeLeaveType[]
  /// Per-row Leave Method overrides. Rows without an entry default to
  /// `{ method: "DEFAULT" }` at commit time.
  leaveSeedByRow: Record<number, PerRowLeaveSeed>
  /// Called when the admin flips a row's leave method selector. On
  /// switching to Custom the parent also opens the PerRowLeaveDialog
  /// for that row.
  onRowLeaveMethodChange: (rowIndex: number, method: "ORG_DEFAULT" | "DEFAULT" | "CUSTOM") => void
  /// Called when the admin clicks the "Custom (N)" badge to re-open
  /// the dialog for an already-customised row.
  onEditRowLeave: (rowIndex: number) => void
  /// Per-row Policy/Project/Team/Layer override callback. Unchanged
  /// from previous behaviour — separate path from the Leave Method
  /// state above.
  onOverrideChange: (
    rowIndex: number,
    patch: Partial<RowOverrides[number]>,
  ) => void
  onRefreshPickers: () => void
  onBack: () => void
  onCommit: () => void
  busy: boolean
}) {
  // Show non-hierarchy columns first, then the hierarchy ones at the
  // right edge so admins always know where to find the pickers.
  // `name` is pulled out separately so it can be rendered as a
  // sticky-left column — the admin always sees which employee the
  // row belongs to even when scrolled all the way over to the
  // hierarchy pickers.
  const allCols =
    preview.preview.length > 0 ? Object.keys(preview.preview[0]) : []
  const hasNameCol = allCols.includes("name")
  const dataCols = allCols.filter(
    (c) => !HIERARCHY_COLUMNS.includes(c) && c !== "name",
  )

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Showing all {preview.preview.length} data
        {preview.preview.length === 1 ? " row" : " rows"} after mapping
        and normalisation. The pickers on the right let you set each
        row&apos;s Policy / Project / Team / Layer — if your CSV
        didn&apos;t carry those columns, use these instead. New records
        can be added inline with{" "}
        <span className="font-medium text-foreground">+ Create</span>.
      </p>

      {/* Per-row Leave Method lives in the table itself now (rightmost
          column). The old per-batch <LeaveMethodSection /> at the top
          of this step has been removed — see the plan in
          ~/.claude/plans/when-the-first-layer-synthetic-knuth.md. */}

      {preview.preview.length > 0 ? (
        <BulkApplyHierarchy
          pickerOptions={pickerOptions}
          rowCount={preview.preview.length}
          onApply={(patch) => {
            for (let i = 0; i < preview.preview.length; i++) {
              onOverrideChange(i, patch)
            }
          }}
        />
      ) : null}

      {preview.preview.length > 0 ? (
        <ScrollArea className="max-h-[60vh] overflow-y-auto overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 uppercase tracking-wide text-muted-foreground">
              <tr>
                {hasNameCol ? (
                  // Sticky on the left. Solid background + right
                  // border so the scrolled content underneath
                  // doesn't bleed through visually.
                  <th
                    className="sticky left-0 z-20 whitespace-nowrap bg-muted px-2 py-1.5 text-left font-medium border-r border-border/60"
                  >
                    name
                  </th>
                ) : null}
                {dataCols.map((c) => (
                  <th
                    key={c}
                    className="whitespace-nowrap bg-muted/40 px-2 py-1.5 text-left font-medium"
                  >
                    {c}
                  </th>
                ))}
                <th className="whitespace-nowrap bg-muted/40 px-2 py-1.5 text-left font-medium border-l border-border/60">
                  Policy
                </th>
                <th className="whitespace-nowrap bg-muted/40 px-2 py-1.5 text-left font-medium">
                  Project
                </th>
                <th className="whitespace-nowrap bg-muted/40 px-2 py-1.5 text-left font-medium">
                  Team
                </th>
                <th className="whitespace-nowrap bg-muted/40 px-2 py-1.5 text-left font-medium">
                  Layer
                </th>
                <th className="whitespace-nowrap bg-muted/40 px-2 py-1.5 text-left font-medium border-l border-border/60">
                  Leave
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.preview.map((row, rowIndex) => {
                const rowSeed = leaveSeedByRow[rowIndex] ?? null
                const leaveMethodForRow: "ORG_DEFAULT" | "DEFAULT" | "CUSTOM" =
                  !rowSeed ? "ORG_DEFAULT"
                  : rowSeed.method === "DEFAULT" ? "DEFAULT"
                  : "CUSTOM"
                const customCount =
                  rowSeed && rowSeed.method !== "DEFAULT" && "days" in rowSeed
                    ? customOverrideCount(rowSeed, leaveTypes)
                    : 0
                return (
                  <PreviewRow
                    key={rowIndex}
                    rowIndex={rowIndex}
                    row={row}
                    hasNameCol={hasNameCol}
                    dataCols={dataCols}
                    pickerOptions={pickerOptions}
                    override={rowOverrides[rowIndex] ?? {}}
                    onOverrideChange={onOverrideChange}
                    onRefreshPickers={onRefreshPickers}
                    leaveMethodForRow={leaveMethodForRow}
                    leaveCustomCount={customCount}
                    onRowLeaveMethodChange={onRowLeaveMethodChange}
                    onEditRowLeave={onEditRowLeave}
                  />
                )
              })}
            </tbody>
          </table>
        </ScrollArea>
      ) : (
        <p className="text-xs text-muted-foreground">
          No rows would be imported with the current mapping. Go back
          and check the column mapping.
        </p>
      )}

      {/* The preview now shows every parsed row, so the
          "Rows beyond the first N" note is no longer relevant. */}

      {preview.skipped.length > 0 && (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 text-xs dark:border-amber-700/40 dark:bg-amber-950/20">
          <p className="font-medium text-foreground">
            {preview.skipped.length} row
            {preview.skipped.length === 1 ? "" : "s"} will be skipped:
          </p>
          <ul className="mt-1 max-h-32 overflow-y-auto list-disc pl-5 text-muted-foreground">
            {preview.skipped.map((s) => (
              <li key={s.rowNumber}>
                Row {s.rowNumber}: {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.errors.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="font-medium text-destructive">
            {preview.errors.length} row
            {preview.errors.length === 1 ? "" : "s"} have validation
            errors. These rows will be skipped.
          </p>
          <ul className="mt-1 max-h-40 overflow-y-auto space-y-1 text-foreground">
            {preview.errors.map((err) => (
              <li key={err.rowNumber}>
                Row {err.rowNumber}:{" "}
                {err.errors
                  .map((e) => `${e.field}: ${e.message}`)
                  .join("; ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          onClick={onCommit}
          disabled={busy}
        >
          {busy ? "Importing…" : "Confirm import"}
        </Button>
      </div>
    </>
  )
}

/**
 * One row in the preview table. Renders the CSV's normalised values
 * plus four pickers (Policy / Project / Team / Layer) at the right
 * edge. Each picker has a `+ Create new` option that opens an inline
 * mini-form below the dropdown.
 */
function PreviewRow({
  rowIndex,
  row,
  hasNameCol,
  dataCols,
  pickerOptions,
  override,
  onOverrideChange,
  onRefreshPickers,
  leaveMethodForRow,
  leaveCustomCount,
  onRowLeaveMethodChange,
  onEditRowLeave,
}: {
  rowIndex: number
  row: Record<string, string | null>
  /**
   * When true, the parent table has a sticky `name` column rendered
   * to the left of `dataCols`. The row mirrors that with its own
   * sticky-left `<td>` so horizontal scrolling keeps the name pinned.
   */
  hasNameCol: boolean
  dataCols: string[]
  pickerOptions: ImportPickerOptions
  override: RowOverrides[number]
  onOverrideChange: (
    rowIndex: number,
    patch: Partial<RowOverrides[number]>,
  ) => void
  onRefreshPickers: () => void
  /// Per-row Leave Method: ORG_DEFAULT = no entry; DEFAULT = per-policy
  /// entry; CUSTOM = custom days/methods entry. The cell renders a
  /// 3-option selector and a "Custom (N)" badge when CUSTOM.
  leaveMethodForRow: "ORG_DEFAULT" | "DEFAULT" | "CUSTOM"
  leaveCustomCount: number
  onRowLeaveMethodChange: (rowIndex: number, method: "ORG_DEFAULT" | "DEFAULT" | "CUSTOM") => void
  onEditRowLeave: (rowIndex: number) => void
}) {
  // Auto-resolve from the CSV value when the admin hasn't overridden
  // — same name-match the importer will do. This is for display only;
  // the importer redoes the lookup at commit time.
  // When the CSV cell is blank AND no override is set, fall back to
  // the org's seeded default (Monthly/Hourly Workers policy, default
  // project, default team). Admins can hit Import without manually
  // picking on every row; the picker still shows the default ID as
  // its `value` so the choice is visible and overridable.
  const csvPolicy = (row.policyName ?? "").trim()
  const csvProject = (row.projectCode ?? "").trim()
  const csvTeam = (row.teamCode ?? "").trim()
  const csvLayerNum = Number(row.teamLayer ?? "")
  const defaults = pickerOptions.defaults

  const autoPolicy = pickerOptions.policies.find(
    (p) => p.name.toLowerCase() === csvPolicy.toLowerCase(),
  )
  const autoProject = pickerOptions.projects.find(
    (p) => p.name.toLowerCase() === csvProject.toLowerCase(),
  )

  // Default-policy resolution: prefer the org's monthly default;
  // otherwise fall back to the first policy in the picker list so
  // legacy orgs (or orgs that deleted the seeded "Monthly Workers"
  // policy) still get a sensible pre-fill instead of a blank picker.
  // Admin can flip the picker per row before importing.
  const policyFromDefault =
    !override.policyId && !autoPolicy
      ? (defaults.monthlyPolicyId
          ? pickerOptions.policies.find(
              (p) => p.id === defaults.monthlyPolicyId,
            )
          : null) ??
        pickerOptions.policies[0] ??
        null
      : null
  const projectFromDefault =
    !override.projectId && !autoProject
      ? (defaults.projectId
          ? pickerOptions.projects.find((p) => p.id === defaults.projectId)
          : null) ??
        pickerOptions.projects[0] ??
        null
      : null

  const selectedPolicyId =
    override.policyId ?? autoPolicy?.id ?? policyFromDefault?.id ?? ""
  const selectedProjectId =
    override.projectId ?? autoProject?.id ?? projectFromDefault?.id ?? ""

  const autoTeam = pickerOptions.teams.find(
    (t) =>
      t.projectId === selectedProjectId &&
      t.name.toLowerCase() === csvTeam.toLowerCase(),
  )
  // Default team: prefer the seeded default team when its project
  // matches the resolved project; otherwise fall back to the first
  // team scoped to the resolved project. This way every project that
  // has any team gets a sensible pre-fill.
  const teamFromDefault =
    !override.teamId && !autoTeam && selectedProjectId
      ? (defaults.teamId && selectedProjectId === defaults.projectId
          ? pickerOptions.teams.find((t) => t.id === defaults.teamId)
          : null) ??
        pickerOptions.teams.find((t) => t.projectId === selectedProjectId) ??
        null
      : null
  const selectedTeamId =
    override.teamId ?? autoTeam?.id ?? teamFromDefault?.id ?? ""

  const selectedTeam = pickerOptions.teams.find(
    (t) => t.id === selectedTeamId,
  )
  const layerCount = selectedTeam?.layerCount ?? 1
  // Layer fallback chain: explicit admin override → CSV value → the
  // configured default (currently always 1). Always >= 1 and <= the
  // team's layer count so the Select doesn't render a stranded value.
  const desiredLayer =
    override.teamLayer ??
    (Number.isFinite(csvLayerNum) && csvLayerNum > 0
      ? csvLayerNum
      : defaults.teamLayer)
  const selectedLayer = Math.min(Math.max(1, desiredLayer), layerCount)

  // Track which cells were filled from the org default vs CSV/override,
  // so we can render a subtle "(default)" hint next to them.
  const policyUsedDefault = Boolean(policyFromDefault)
  const projectUsedDefault = Boolean(projectFromDefault)
  const teamUsedDefault = Boolean(teamFromDefault)

  // Teams scoped to the currently-selected project, sorted by name.
  const teamOptions = pickerOptions.teams.filter(
    (t) => t.projectId === selectedProjectId,
  )

  return (
    <tr className="border-t border-border/60 align-top">
      {hasNameCol ? (
        // Sticky name cell — stays pinned to the left while the
        // admin scrolls horizontally to reach the hierarchy
        // pickers. `bg-card` matches the dialog body so scrolled
        // content doesn't bleed through.
        <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-2 py-1.5 text-foreground font-medium border-r border-border/60">
          {row.name ?? "—"}
        </td>
      ) : null}
      {dataCols.map((c) => (
        <td
          key={c}
          className="whitespace-nowrap px-2 py-1.5 text-foreground"
        >
          {row[c] ?? "—"}
        </td>
      ))}

      {/* Policy */}
      <td className="whitespace-nowrap px-2 py-1.5 border-l border-border/60">
        <CreatableSelect
          value={selectedPolicyId}
          placeholder={csvPolicy || "Pick a policy"}
          options={pickerOptions.policies}
          onPick={(id) => onOverrideChange(rowIndex, { policyId: id })}
          createLabel="+ Create policy"
          onCreate={async (name) => {
            const res = await createImportPolicyAction({ name })
            if (res.status === "error") throw new Error(res.message)
            onOverrideChange(rowIndex, { policyId: res.id })
            onRefreshPickers()
          }}
        />
        {policyUsedDefault ? (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">
            (default)
          </span>
        ) : null}
      </td>

      {/* Project */}
      <td className="whitespace-nowrap px-2 py-1.5">
        <CreatableSelect
          value={selectedProjectId}
          placeholder={csvProject || "Pick a project"}
          options={pickerOptions.projects}
          onPick={(id) => {
            // Clearing the project also clears the team override —
            // teams are scoped per project.
            onOverrideChange(rowIndex, {
              projectId: id,
              teamId: undefined,
              teamLayer: undefined,
            })
          }}
          createLabel="+ Create project"
          onCreate={async (name) => {
            const res = await createImportProjectAction({ name })
            if (res.status === "error") throw new Error(res.message)
            onOverrideChange(rowIndex, {
              projectId: res.id,
              teamId: undefined,
              teamLayer: undefined,
            })
            onRefreshPickers()
          }}
        />
        {projectUsedDefault ? (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">
            (default)
          </span>
        ) : null}
      </td>

      {/* Team */}
      <td className="whitespace-nowrap px-2 py-1.5">
        <CreatableSelect
          value={selectedTeamId}
          placeholder={
            !selectedProjectId
              ? "Pick a project first"
              : csvTeam || "Pick a team"
          }
          options={teamOptions.map((t) => ({ id: t.id, name: t.name }))}
          disabled={!selectedProjectId}
          onPick={(id) => onOverrideChange(rowIndex, { teamId: id })}
          createLabel="+ Create team"
          onCreate={
            selectedProjectId
              ? async (name) => {
                  const res = await createImportTeamAction({
                    projectId: selectedProjectId,
                    name,
                    layerCount: 1,
                  })
                  if (res.status === "error") throw new Error(res.message)
                  onOverrideChange(rowIndex, { teamId: res.id })
                  onRefreshPickers()
                }
              : undefined
          }
        />
        {teamUsedDefault ? (
          <span className="mt-0.5 block text-[10px] text-muted-foreground">
            (default)
          </span>
        ) : null}
      </td>

      {/* Layer */}
      <td className="whitespace-nowrap px-2 py-1.5">
        <Select
          value={String(selectedLayer)}
          onValueChange={(next) =>
            onOverrideChange(rowIndex, { teamLayer: Number(next) })
          }
        >
          <SelectTrigger className="h-8 w-20 rounded-md border-border/70 bg-background px-2 text-xs shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: layerCount }, (_, i) => i + 1).map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
      {/* Per-row Leave Method cell. Three options:
          - Org default: seed from leave-type defaults (skip policy layer)
          - Per policy: seed from policy/type chain
          - Custom…: open dialog for per-type overrides */}
      <td className="px-2 py-1.5 align-middle border-l border-border/60">
        {leaveMethodForRow !== "CUSTOM" ? (
          <Select
            value={leaveMethodForRow}
            onValueChange={(v) =>
              onRowLeaveMethodChange(rowIndex, v as "ORG_DEFAULT" | "DEFAULT" | "CUSTOM")
            }
          >
            <SelectTrigger className="h-8 w-32 rounded-md border-border/70 bg-background px-2 text-xs shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ORG_DEFAULT">Org default</SelectItem>
              <SelectItem value="DEFAULT">Per policy</SelectItem>
              <SelectItem value="CUSTOM">Custom…</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onEditRowLeave(rowIndex)}
              className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/15"
              title="Edit this row's per-leave-type entitlements"
            >
              Custom ({leaveCustomCount})
            </button>
            <button
              type="button"
              onClick={() => onRowLeaveMethodChange(rowIndex, "ORG_DEFAULT")}
              className="text-[10px] text-muted-foreground underline hover:text-foreground"
              title="Reset this row back to org default seeding"
            >
              clear
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}

/**
 * "Bulk apply" card above the preview table. Lets an admin pick
 * Policy / Project / Team / Layer once and push the values into
 * every row's `override` slot in a single click. Each field is
 * optional — unset fields are skipped at apply time (so admins can
 * bulk-apply just the policy, for example, without overwriting
 * already-correct project/team picks).
 */
function BulkApplyHierarchy({
  pickerOptions,
  rowCount,
  onApply,
}: {
  pickerOptions: ImportPickerOptions
  rowCount: number
  onApply: (patch: {
    policyId?: string
    projectId?: string
    teamId?: string
    teamLayer?: number
  }) => void
}) {
  const [policyId, setPolicyId] = useState<string>("")
  const [projectId, setProjectId] = useState<string>("")
  const [teamId, setTeamId] = useState<string>("")
  const [teamLayer, setTeamLayer] = useState<string>("")

  const teamsForProject = pickerOptions.teams.filter(
    (t) => !projectId || t.projectId === projectId,
  )
  const selectedTeam = pickerOptions.teams.find((t) => t.id === teamId)
  const layerCount = selectedTeam?.layerCount ?? 1

  const hasAnySelection = Boolean(
    policyId || projectId || teamId || teamLayer,
  )

  function handleApply() {
    const patch: {
      policyId?: string
      projectId?: string
      teamId?: string
      teamLayer?: number
    } = {}
    if (policyId) patch.policyId = policyId
    if (projectId) {
      patch.projectId = projectId
      // Clear team/layer when project changes so per-row state
      // doesn't end up pointing at a team under the wrong project.
      patch.teamId = teamId || undefined
      patch.teamLayer = teamLayer ? Number(teamLayer) : undefined
    } else {
      if (teamId) patch.teamId = teamId
      if (teamLayer) patch.teamLayer = Number(teamLayer)
    }
    onApply(patch)
  }

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">
          Bulk apply to all rows
        </p>
        <p className="text-[11px] text-muted-foreground">
          Pick any field then click Apply — applies to all {rowCount} rows.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">Policy</label>
          <Select
            value={policyId || "__none"}
            onValueChange={(v) => setPolicyId(v === "__none" ? "" : v)}
          >
            <SelectTrigger className="h-8 w-40 rounded-md border-border/70 bg-background px-2 text-xs shadow-none">
              <SelectValue placeholder="— Leave unchanged —" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">— Leave unchanged —</SelectItem>
              {pickerOptions.policies.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">Project</label>
          <Select
            value={projectId || "__none"}
            onValueChange={(v) => {
              setProjectId(v === "__none" ? "" : v)
              // Reset dependent picks when project changes.
              setTeamId("")
              setTeamLayer("")
            }}
          >
            <SelectTrigger className="h-8 w-40 rounded-md border-border/70 bg-background px-2 text-xs shadow-none">
              <SelectValue placeholder="— Leave unchanged —" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">— Leave unchanged —</SelectItem>
              {pickerOptions.projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">Team</label>
          <Select
            value={teamId || "__none"}
            onValueChange={(v) => setTeamId(v === "__none" ? "" : v)}
            disabled={!projectId}
          >
            <SelectTrigger className="h-8 w-40 rounded-md border-border/70 bg-background px-2 text-xs shadow-none">
              <SelectValue
                placeholder={
                  projectId ? "— Leave unchanged —" : "Pick a project first"
                }
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">— Leave unchanged —</SelectItem>
              {teamsForProject.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">Layer</label>
          <Select
            value={teamLayer || "__none"}
            onValueChange={(v) => setTeamLayer(v === "__none" ? "" : v)}
            disabled={!teamId}
          >
            <SelectTrigger className="h-8 w-20 rounded-md border-border/70 bg-background px-2 text-xs shadow-none">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">—</SelectItem>
              {Array.from({ length: layerCount }, (_, i) => i + 1).map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleApply}
          disabled={!hasAnySelection}
        >
          Apply to all rows
        </Button>
      </div>
    </div>
  )
}

/**
 * Generic select with an inline "+ Create new" option. When the admin
 * clicks the create item, the dropdown closes and a mini form appears
 * below with a name input + Create button. `onCreate` is awaited so
 * the parent can refresh picker options before the row updates.
 */
function CreatableSelect({
  value,
  placeholder,
  options,
  onPick,
  createLabel,
  onCreate,
  disabled,
}: {
  value: string
  placeholder: string
  options: Array<{ id: string; name: string }>
  onPick: (id: string) => void
  createLabel: string
  /**
   * When omitted, the "+ Create new" item is hidden — useful for the
   * Team picker when no project has been selected.
   */
  onCreate?: (name: string) => Promise<void>
  disabled?: boolean
}) {
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState("")
  const [createError, setCreateError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submitCreate() {
    if (!onCreate) return
    const name = draftName.trim()
    if (!name) {
      setCreateError("Name is required")
      return
    }
    setPending(true)
    setCreateError(null)
    try {
      await onCreate(name)
      setCreating(false)
      setDraftName("")
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <Select
        value={value || "__none"}
        onValueChange={(next) => {
          if (next === "__create") {
            setCreating(true)
            return
          }
          onPick(next)
        }}
        disabled={disabled}
      >
        <SelectTrigger className="h-8 w-40 rounded-md border-border/70 bg-background px-2 text-xs shadow-none">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No options yet.
            </div>
          ) : (
            options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))
          )}
          {onCreate ? (
            <SelectItem value="__create">
              <span className="font-medium text-primary">{createLabel}</span>
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>

      {creating && onCreate && (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="New name"
            className="h-7 w-32 rounded-md border border-border/70 bg-background px-2 text-xs"
            autoFocus
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={pending}
            onClick={submitCreate}
          >
            {pending ? "…" : "Create"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-1.5 text-[11px]"
            disabled={pending}
            onClick={() => {
              setCreating(false)
              setDraftName("")
              setCreateError(null)
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {createError && (
        <p className="text-[11px] text-destructive">{createError}</p>
      )}
    </div>
  )
}

// ─── Leave Method picker (per-batch, lives at top of Preview step) ──────

/// Per-row Leave Method popup. Replaces the old per-batch
/// `LeaveMethodSection`. Opens when the admin flips a preview row's
/// selector to Custom or clicks the "Custom (N)" badge to re-edit.
///
/// Mounted in the wizard at the same level as the main DialogContent
/// (not nested inside it) — Radix Dialogs don't compose well when
/// nested, focus traps fight each other.
///
/// Edits are staged locally in the dialog and only propagate to
/// wizard state when the admin clicks Save. Cancel discards the
/// changes (or, if the row had no entry before, drops it back to
/// Default).
function PerRowLeaveDialog({
  rowIndex,
  previewRow,
  leaveTypes,
  seed,
  onSave,
  onCancel,
}: {
  rowIndex: number | null
  previewRow: Record<string, string | null> | null
  leaveTypes: AddEmployeeLeaveType[]
  seed: Extract<PerRowLeaveSeed, { days: Record<string, number> }> | null
  onSave: (rowIndex: number, next: Extract<PerRowLeaveSeed, { days: Record<string, number> }>) => void
  onCancel: () => void
}) {
  // Local staging copy. Initialised from the wizard's current seed
  // when the dialog opens for a new row. We re-init on every
  // open via the key on Dialog below, so reopening for a different
  // row doesn't leak state.
  type CustomSeed = Extract<PerRowLeaveSeed, { days: Record<string, number> }>
  const [local, setLocal] = useState<CustomSeed>(
    () => (seed ?? blankLeaveSeed(leaveTypes)) as CustomSeed,
  )

  // Friendly title — best-effort name/email from the parsed row.
  const label =
    previewRow?.name?.trim() ||
    previewRow?.email?.trim() ||
    `Row ${rowIndex !== null ? rowIndex + 1 : "?"}`

  return (
    <Dialog
      open={rowIndex !== null}
      onOpenChange={(o) => {
        if (!o) onCancel()
      }}
    >
      <DialogContent
        key={rowIndex ?? "closed"}
        className="sm:max-w-md"
        onOpenAutoFocus={(e) => {
          // Re-seed local state every time the dialog opens for a
          // new row, so editing row A → opening row B starts from
          // B's stored seed (or blank), not A's last typed values.
          setLocal((seed ?? blankLeaveSeed(leaveTypes)) as CustomSeed)
          // Don't steal focus aggressively — first input would be
          // OK but the days inputs are usually what admins want.
          e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Leave entitlements — {label}</DialogTitle>
          <DialogDescription>
            Override the leave type defaults for this employee. Days
            you don&apos;t change inherit from the type default.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-2 px-1 py-2">
          {leaveTypes.map((t) => {
            const isAnnual = t.code.toUpperCase() === "ANNUAL"
            return (
              <div
                key={t.id}
                className="grid grid-cols-[1fr_5rem_8rem] items-center gap-2 text-xs"
              >
                <div className="truncate">
                  <span className="font-mono text-[10px] font-bold mr-1.5">
                    {t.code}
                  </span>
                  {t.name}
                </div>
                <Input
                  type="number"
                  step="0.5"
                  min="0"
                  value={String(local.days[t.id] ?? t.defaultDays)}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isNaN(n)) return
                    setLocal((prev) => ({
                      ...prev,
                      days: { ...prev.days, [t.id]: Math.max(0, n) },
                    }))
                  }}
                  disabled={!t.paid}
                  className="h-8 text-xs"
                />
                {/* ANNUAL-only rule: method selector only on the
                    Annual row. Other types are locked at LUMP_SUM. */}
                {isAnnual ? (
                  <NativeSelect
                    value={local.methods[t.id] ?? t.accrualMethod}
                    onChange={(e) =>
                      setLocal((prev) => ({
                        ...prev,
                        methods: {
                          ...prev.methods,
                          [t.id]: e.target.value as "LUMP_SUM" | "PRO_RATED",
                        },
                      }))
                    }
                    disabled={!t.paid}
                  >
                    <option value="LUMP_SUM">Lump sum</option>
                    <option value="PRO_RATED">Pro-rated</option>
                  </NativeSelect>
                ) : (
                  <span />
                )}
              </div>
            )
          })}
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (rowIndex !== null) onSave(rowIndex, local)
            }}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Step 4: done ──────────────────────────────────────────────────────

function DoneStep({
  result,
  onClose,
}: {
  result: MappedImportResult
  onClose: () => void
}) {
  // "Nothing imported because every row had an error" needs a
  // different framing than "all rows imported successfully", which
  // needs a different framing again from "some rows imported, some
  // had errors". Pick the headline + colour based on what actually
  // landed in the DB.
  const everythingFailed =
    result.created === 0 &&
    result.updated === 0 &&
    result.errors.length > 0
  const partialSuccess =
    (result.created > 0 || result.updated > 0) && result.errors.length > 0

  return (
    <>
      {everythingFailed ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm">
          <div className="font-medium text-destructive">
            Import failed — nothing was saved.
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {result.errors.length} row
            {result.errors.length === 1 ? "" : "s"} could not be
            imported. See the details below, fix the file, and try
            again.
          </div>
        </div>
      ) : partialSuccess ? (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 text-sm dark:border-amber-700/40 dark:bg-amber-950/20">
          <div className="font-medium text-foreground">
            Import partially complete.
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {result.created} created · {result.updated} updated ·{" "}
            {result.errors.length} row
            {result.errors.length === 1 ? "" : "s"} failed ·{" "}
            {result.skipped.length} skipped · {result.total} rows in
            file.
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-300/60 bg-emerald-50/40 p-3 text-sm dark:border-emerald-700/40 dark:bg-emerald-950/20">
          <div className="font-medium">Import complete.</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {result.created} created · {result.updated} updated ·{" "}
            {result.skipped.length} skipped · {result.total} rows in
            file.
          </div>
        </div>
      )}

      {result.errors.length > 0 && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="font-medium text-foreground">
            Errors that blocked these rows:
          </p>
          <ul className="mt-1 max-h-48 overflow-y-auto space-y-1.5 text-muted-foreground">
            {result.errors.map((rowError, idx) => (
              <li key={`${rowError.rowNumber}-${idx}`}>
                {rowError.rowNumber > 0 ? (
                  <span className="font-medium text-foreground">
                    Row {rowError.rowNumber}:
                  </span>
                ) : null}{" "}
                <ul className="mt-0.5 list-disc pl-5">
                  {rowError.errors.map((fe, j) => (
                    <li key={j}>
                      <span className="font-medium text-foreground">
                        {fe.field}
                      </span>{" "}
                      — {fe.message}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.skipped.length > 0 && (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 text-xs dark:border-amber-700/40 dark:bg-amber-950/20">
          <p className="font-medium text-foreground">
            Skipped rows:
          </p>
          <ul className="mt-1 max-h-40 overflow-y-auto list-disc pl-5 text-muted-foreground">
            {result.skipped.map((s) => (
              <li key={s.rowNumber}>
                Row {s.rowNumber}: {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end pt-2">
        <Button type="button" onClick={onClose}>
          {everythingFailed ? "Close" : "Done"}
        </Button>
      </div>
    </>
  )
}
