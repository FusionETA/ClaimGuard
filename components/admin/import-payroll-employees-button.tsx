"use client"

import { useActionState, useState, useTransition } from "react"
import { Download, Sparkles, Upload } from "lucide-react"

import {
  aiMapCsvAction,
  importMappedCsvAction,
  previewMappedCsvAction,
  type AiMapActionResult,
} from "@/app/(admin)/admin/payroll/employees/import-actions"
import type { ColumnMapping, MappingMethod } from "@/lib/ai/csv-mapper"
import type {
  MappedImportResult,
  PreviewResult,
} from "@/modules/payroll/application/services/payroll-import.service"
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
import { cn } from "@/lib/utils"

/**
 * Multi-step CSV import dialog with AI column mapping.
 *
 * Steps:
 *   1. UPLOAD        — admin picks a CSV file. Server reads it, calls
 *                      GROQ for a column-mapping suggestion.
 *   2. MAP_REVIEW    — admin reviews every source column's mapping
 *                      (AI suggestion pre-selected). Override with
 *                      dropdowns. Confidence badges flag uncertain
 *                      mappings.
 *   3. PREVIEW       — first 5 normalised rows shown so admin can
 *                      sanity-check. Skipped rows listed below with
 *                      reasons.
 *   4. DONE          — final counts after commit.
 */
type Step = "upload" | "map" | "preview" | "done"

export function ImportPayrollEmployeesButton() {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>("upload")
  const [csvText, setCsvText] = useState<string>("")
  const [headers, setHeaders] = useState<string[]>([])
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [aiSuggestion, setAiSuggestion] = useState<ColumnMapping[]>([])
  const [mappingMethod, setMappingMethod] = useState<MappingMethod | null>(
    null,
  )
  const [warnings, setWarnings] = useState<string[]>([])
  const [targetSchema, setTargetSchema] = useState<
    Array<{ key: string; required: boolean; description: string }>
  >([])
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [finalResult, setFinalResult] = useState<MappedImportResult | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const [, mapAction, mapPending] = useActionState<
    AiMapActionResult | null,
    FormData
  >(async (_prev, formData) => {
    setError(null)
    const result = await aiMapCsvAction(_prev, formData)
    if (result.status === "success") {
      setCsvText(result.csvText)
      setHeaders(result.headers)
      setAiSuggestion(result.mappings)
      setMappingMethod(result.method)
      setWarnings(result.warnings)
      setTargetSchema(result.targetSchema)
      // Seed the mapping with AI's picks.
      const seed: Record<string, string | null> = {}
      for (const m of result.mappings) {
        seed[m.sourceColumn] = m.ourField
      }
      setMapping(seed)
      setStep("map")
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
    setMappingMethod(null)
    setWarnings([])
    setPreview(null)
    setFinalResult(null)
    setError(null)
  }

  function close() {
    setOpen(false)
    // Defer reset so the closing animation has clean state.
    setTimeout(reset, 200)
  }

  function goToPreview() {
    setError(null)
    startTransition(async () => {
      const result = await previewMappedCsvAction({ csvText, mapping })
      if (result.status === "success") {
        setPreview(result.result)
        setStep("preview")
      } else {
        setError(result.message)
      }
    })
  }

  function commit() {
    setError(null)
    startTransition(async () => {
      const result = await importMappedCsvAction({ csvText, mapping })
      if (result.status === "success") {
        setFinalResult(result.result)
        setStep("done")
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
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-xl">
            Bulk import employees
          </DialogTitle>
          <DialogDescription>
            Upload any CSV — our AI maps your columns to our schema.
            Required fields marked <span className="font-mono">*</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto max-h-[calc(85vh-10rem)]">
          <Stepper step={step} />

          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {step === "upload" && (
            <UploadStep action={mapAction} pending={mapPending} />
          )}

          {step === "map" && (
            <MapStep
              headers={headers}
              mapping={mapping}
              aiSuggestion={aiSuggestion}
              warnings={warnings}
              method={mappingMethod}
              targetSchema={targetSchema}
              onChange={(source, field) =>
                setMapping((m) => ({ ...m, [source]: field }))
              }
              onBack={reset}
              onNext={goToPreview}
              busy={isPending}
            />
          )}

          {step === "preview" && preview && (
            <PreviewStep
              preview={preview}
              onBack={() => setStep("map")}
              onCommit={commit}
              busy={isPending}
            />
          )}

          {step === "done" && finalResult && (
            <DoneStep result={finalResult} onClose={close} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Stepper ────────────────────────────────────────────────────────────

function Stepper({ step }: { step: Step }) {
  const items: Array<{ key: Step; label: string }> = [
    { key: "upload", label: "Upload" },
    { key: "map", label: "Review mapping" },
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

// ─── Mapping-method badge ───────────────────────────────────────────────

function MethodBadge({ method }: { method: MappingMethod }) {
  const config = {
    groq: {
      label: "AI: GROQ",
      hint: "Mapping suggested by GROQ (Llama 3.3). Review and override anything that looks off.",
      className:
        "border-primary/40 bg-primary/5 text-primary",
    },
    gemini: {
      label: "AI: Gemini",
      hint: "GROQ was unreachable — fell back to Gemini. Review carefully.",
      className:
        "border-amber-300/60 bg-amber-50/40 text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-200",
    },
    heuristic: {
      label: "Offline (heuristic)",
      hint: "Both AI providers unreachable. Mapping is based on header synonyms only — review every row.",
      className:
        "border-destructive/40 bg-destructive/5 text-destructive",
    },
  }[method]
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-xs",
        config.className,
      )}
    >
      <div className="font-medium">{config.label}</div>
      <div className="mt-0.5 opacity-80">{config.hint}</div>
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
              Header-only template. Required columns prefixed with{" "}
              <span className="font-mono">*</span>.
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="gap-2">
            <a href="/admin/payroll/employees/import-template" download>
              <Download className="h-4 w-4" />
              Download template
            </a>
          </Button>
        </div>
      </div>

      <form action={action} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="csv-file" className="text-xs">
            CSV file
          </Label>
          <input
            id="csv-file"
            type="file"
            name="file"
            accept=".csv,text/csv"
            required
            className="block w-full rounded-md border border-border bg-card px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary"
          />
          <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
            <Sparkles className="h-3 w-3" />
            AI will read your column names and map them to our schema.
            You&apos;ll review before any data is imported.
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

// ─── Step 2: map review ─────────────────────────────────────────────────

function MapStep({
  headers,
  mapping,
  aiSuggestion,
  warnings,
  method,
  targetSchema,
  onChange,
  onBack,
  onNext,
  busy,
}: {
  headers: string[]
  mapping: Record<string, string | null>
  aiSuggestion: ColumnMapping[]
  warnings: string[]
  method: MappingMethod | null
  targetSchema: Array<{ key: string; required: boolean; description: string }>
  onChange: (source: string, field: string | null) => void
  onBack: () => void
  onNext: () => void
  busy: boolean
}) {
  const suggestionMap = new Map(aiSuggestion.map((s) => [s.sourceColumn, s]))
  return (
    <>
      {method && <MethodBadge method={method} />}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 text-sm dark:border-amber-700/40 dark:bg-amber-950/20">
          <p className="font-medium text-foreground">AI flagged:</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border/60">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">
                Your column
              </th>
              <th className="px-3 py-2 text-left font-medium">
                Mapped to
              </th>
              <th className="px-3 py-2 text-left font-medium w-24">
                Confidence
              </th>
            </tr>
          </thead>
          <tbody>
            {headers.map((h) => {
              const suggestion = suggestionMap.get(h)
              const current = mapping[h] ?? ""
              return (
                <tr key={h} className="border-t border-border/60">
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium text-foreground">{h}</div>
                    {suggestion?.reason && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {suggestion.reason}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      value={current ?? ""}
                      onChange={(e) =>
                        onChange(h, e.target.value === "" ? null : e.target.value)
                      }
                      className="h-9 w-full max-w-xs rounded-md border border-border bg-card px-2 text-sm"
                    >
                      <option value="">— skip column —</option>
                      {targetSchema.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.required ? `* ${f.key}` : f.key}
                        </option>
                      ))}
                    </select>
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
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={onNext} disabled={busy}>
          {busy ? "Loading preview…" : "Next: preview"}
        </Button>
      </div>
    </>
  )
}

// ─── Step 3: preview ───────────────────────────────────────────────────

function PreviewStep({
  preview,
  onBack,
  onCommit,
  busy,
}: {
  preview: PreviewResult
  onBack: () => void
  onCommit: () => void
  busy: boolean
}) {
  const cols =
    preview.preview.length > 0 ? Object.keys(preview.preview[0]) : []
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Showing first {preview.preview.length} of {preview.total} data
        rows after mapping and normalisation. Verify the values look
        right before committing.
      </p>

      {preview.preview.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 uppercase tracking-wide text-muted-foreground">
              <tr>
                {cols.map((c) => (
                  <th
                    key={c}
                    className="whitespace-nowrap px-2 py-1.5 text-left font-medium"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.preview.map((row, i) => (
                <tr key={i} className="border-t border-border/60">
                  {cols.map((c) => (
                    <td
                      key={c}
                      className="whitespace-nowrap px-2 py-1.5 text-foreground"
                    >
                      {row[c] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No rows would be imported with the current mapping. Go back
          and check the column mapping.
        </p>
      )}

      {preview.skipped.length > 0 && (
        <div className="rounded-lg border border-amber-300/60 bg-amber-50/40 p-3 text-xs dark:border-amber-700/40 dark:bg-amber-950/20">
          <p className="font-medium text-foreground">
            {preview.skipped.length} row
            {preview.skipped.length === 1 ? "" : "s"} will be skipped
            (missing required fields):
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
            errors. Import will be blocked.
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
          disabled={busy || preview.errors.length > 0}
        >
          {busy ? "Importing…" : "Confirm import"}
        </Button>
      </div>
    </>
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
  return (
    <>
      <div className="rounded-lg border border-emerald-300/60 bg-emerald-50/40 p-3 text-sm dark:border-emerald-700/40 dark:bg-emerald-950/20">
        <div className="font-medium">Import complete.</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {result.created} created · {result.updated} updated ·{" "}
          {result.skipped.length} skipped · {result.total} rows in
          file.
        </div>
      </div>

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
          Done
        </Button>
      </div>
    </>
  )
}
