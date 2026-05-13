"use server"

import { revalidatePath } from "next/cache"

import { aiMapCsvColumns } from "@/lib/ai/csv-mapper-ai"
import { getTargetSchemaForHeaders } from "@/lib/ai/csv-mapper"
import type {
  ColumnMapping,
  MappingMethod,
  SchemaField,
} from "@/lib/ai/csv-mapper"
import {
  bulkImportPayrollEmployees,
  extractCsvPreview,
  importMappedCsv,
  previewMappedCsv,
  type ImportResult,
  type MappedImportResult,
  type PreviewResult,
} from "@/modules/payroll/application/services/payroll-import.service"

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
      message: err instanceof Error ? err.message : "Import failed.",
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
      message: err instanceof Error ? err.message : "Mapping failed.",
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

// ─── Preview ────────────────────────────────────────────────────────────

export type PreviewActionResult =
  | { status: "success"; result: PreviewResult }
  | { status: "error"; message: string }

export async function previewMappedCsvAction(input: {
  csvText: string
  mapping: Record<string, string | null>
}): Promise<PreviewActionResult> {
  try {
    const result = await previewMappedCsv({
      csv: input.csvText,
      mapping: input.mapping,
    })
    return { status: "success", result }
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Preview failed.",
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
}): Promise<MappedImportActionResult> {
  try {
    const result = await importMappedCsv({
      csv: input.csvText,
      mapping: input.mapping,
    })
    revalidatePath("/admin/payroll/employees")
    revalidatePath("/admin/hierarchy")
    return { status: "success", result }
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Import failed.",
    }
  }
}
