import "server-only"

import { parseCsv } from "@/modules/payroll/application/services/payroll-import.service"
import { organizationRepository } from "@/modules/organization/infrastructure/organization.repository"

/**
 * CSV bulk-import service for manually-managed organisations — i.e.
 * organisations that aren't connected to Xero and therefore can't pull
 * their chart of accounts / project list via the Xero sync. Lets the
 * admin upload a CSV instead of clicking "Add" N times.
 *
 * Both importers share the same shape:
 *   - parse the CSV using the same RFC 4180 parser used by the
 *     payroll-employee import (no new CSV dependency)
 *   - lowercase + trim header cells, map header → column index
 *   - validate every row (required fields, no obvious junk)
 *   - skip rows whose unique key already exists in the org (dupes)
 *   - create one DB row per non-dupe valid row
 *   - return per-import counts + a row-level error list so the admin
 *     can fix and re-upload only the bad rows
 *
 * Append-only by design — no row is ever updated or deleted. Admins
 * can safely re-run an import without fear of clobbering data.
 */

export type CsvImportResult = {
  /** Rows that produced a new DB row. */
  imported: number
  /** Rows skipped because the unique key already existed in the org. */
  skipped: number
  /** Rows rejected because of bad / missing required values. 1-based
   *  row numbers as the admin sees them in their spreadsheet (header
   *  is row 1, first data row is row 2, etc). */
  errors: Array<{ row: number; message: string }>
}

// ─── Header normalisation ───────────────────────────────────────────────────

/**
 * Lower-case, strip surrounding whitespace, and strip a leading `*`
 * (matches the payroll import's "required tier marker" convention so
 * templates can be reused).
 */
function normaliseHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/^\*+/, "").trim()
}

/**
 * Resolve a header's column index, accepting any of several aliases.
 * Returns -1 if none of the aliases were found.
 */
function findColumn(headers: string[], aliases: readonly string[]): number {
  const normalised = headers.map(normaliseHeader)
  for (const alias of aliases) {
    const idx = normalised.indexOf(alias)
    if (idx !== -1) return idx
  }
  return -1
}

function cellAt(row: string[], idx: number): string {
  if (idx < 0) return ""
  const raw = row[idx]
  return typeof raw === "string" ? raw.trim() : ""
}

function parseBooleanish(value: string, fallback: boolean): boolean {
  const v = value.trim().toLowerCase()
  if (v === "") return fallback
  if (v === "true" || v === "yes" || v === "y" || v === "1") return true
  if (v === "false" || v === "no" || v === "n" || v === "0") return false
  return fallback
}

function parseNumberish(value: string): number | null {
  const t = value.trim()
  if (t === "") return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

// ─── Chart of accounts import ───────────────────────────────────────────────

/**
 * Expected headers (case-insensitive, trimmed). The admin can omit
 * optional columns entirely — they just won't be populated.
 *
 *   *code         (required)  account code, e.g. "5100"
 *   *name         (required)  account name, e.g. "Office Supplies"
 *   type          (optional)  EXPENSE | BANK | REVENUE | etc.
 *   selectable    (optional)  true/false — defaults to true. Controls
 *                             whether employees see this account in
 *                             the claim form's account picker.
 */
export async function importCustomChartAccountsCsv(input: {
  organizationId: string
  csvText: string
}): Promise<CsvImportResult> {
  const rows = parseCsv(input.csvText).filter(
    (r) => r.length > 0 && r.some((c) => c.trim().length > 0),
  )

  if (rows.length === 0) {
    return { imported: 0, skipped: 0, errors: [{ row: 1, message: "CSV is empty." }] }
  }

  const [headerRow, ...dataRows] = rows
  const codeIdx = findColumn(headerRow, ["code", "account code"])
  const nameIdx = findColumn(headerRow, ["name", "account name"])
  const typeIdx = findColumn(headerRow, ["type", "account type"])
  const selIdx = findColumn(headerRow, ["selectable", "isselectable", "is selectable"])

  if (codeIdx === -1 || nameIdx === -1) {
    return {
      imported: 0,
      skipped: 0,
      errors: [
        {
          row: 1,
          message:
            "CSV is missing required columns. Need at least 'code' and 'name'.",
        },
      ],
    }
  }

  // Pre-load existing codes ONCE — duplicate check becomes O(1) per row
  // instead of a query per row.
  const existing = await organizationRepository.getChartAccountsForOrganization(
    input.organizationId,
  )
  const existingCodes = new Set(existing.map((a) => a.code.trim().toLowerCase()))

  // Also track codes we've already imported in THIS run so two rows
  // with the same code in the same file don't both try to insert.
  const seenInBatch = new Set<string>()

  const result: CsvImportResult = { imported: 0, skipped: 0, errors: [] }

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const lineNumber = i + 2 // 1-based, +1 for the header row

    const code = cellAt(row, codeIdx)
    const name = cellAt(row, nameIdx)
    const type = cellAt(row, typeIdx) || undefined
    const isSelectable = parseBooleanish(cellAt(row, selIdx), true)

    if (!code) {
      result.errors.push({ row: lineNumber, message: "Missing required 'code'." })
      continue
    }
    if (!name) {
      result.errors.push({ row: lineNumber, message: "Missing required 'name'." })
      continue
    }

    const key = code.toLowerCase()
    if (existingCodes.has(key) || seenInBatch.has(key)) {
      result.skipped += 1
      continue
    }

    try {
      await organizationRepository.createCustomChartAccount({
        organizationId: input.organizationId,
        code,
        name,
        type,
        isSelectable,
      })
      seenInBatch.add(key)
      result.imported += 1
    } catch (err) {
      result.errors.push({
        row: lineNumber,
        message: err instanceof Error ? err.message : "Failed to insert row.",
      })
    }
  }

  return result
}

// ─── Manual projects import ─────────────────────────────────────────────────

/**
 * Expected headers (case-insensitive, trimmed). PM assignment is NOT
 * supported via CSV — admins set project managers via the per-project
 * edit dialog after import, because PMs need to be matched to real
 * user accounts and that's error-prone in a CSV.
 *
 *   *name         (required)  project name
 *   location      (optional)  free-form label (e.g. street address)
 *   latitude      (optional)  decimal degrees, -90 to 90
 *   longitude     (optional)  decimal degrees, -180 to 180
 *
 * If only one of latitude/longitude is provided, both are ignored
 * (a location pin needs both).
 */
export async function importManualProjectsCsv(input: {
  organizationId: string
  csvText: string
}): Promise<CsvImportResult> {
  const rows = parseCsv(input.csvText).filter(
    (r) => r.length > 0 && r.some((c) => c.trim().length > 0),
  )

  if (rows.length === 0) {
    return { imported: 0, skipped: 0, errors: [{ row: 1, message: "CSV is empty." }] }
  }

  const [headerRow, ...dataRows] = rows
  const nameIdx = findColumn(headerRow, ["name", "project name"])
  const locIdx = findColumn(headerRow, ["location", "address"])
  const latIdx = findColumn(headerRow, ["latitude", "lat"])
  const lngIdx = findColumn(headerRow, ["longitude", "lng", "lon"])

  if (nameIdx === -1) {
    return {
      imported: 0,
      skipped: 0,
      errors: [
        {
          row: 1,
          message: "CSV is missing the required 'name' column.",
        },
      ],
    }
  }

  const existing = await organizationRepository.getProjectsForOrganization(
    input.organizationId,
  )
  const existingNames = new Set(existing.map((p) => p.name.trim().toLowerCase()))
  const seenInBatch = new Set<string>()

  const result: CsvImportResult = { imported: 0, skipped: 0, errors: [] }

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const lineNumber = i + 2

    const name = cellAt(row, nameIdx)
    const location = cellAt(row, locIdx) || undefined
    const latitude = parseNumberish(cellAt(row, latIdx))
    const longitude = parseNumberish(cellAt(row, lngIdx))

    if (!name) {
      result.errors.push({ row: lineNumber, message: "Missing required 'name'." })
      continue
    }

    if (latitude != null && (latitude < -90 || latitude > 90)) {
      result.errors.push({
        row: lineNumber,
        message: "Latitude must be between -90 and 90.",
      })
      continue
    }
    if (longitude != null && (longitude < -180 || longitude > 180)) {
      result.errors.push({
        row: lineNumber,
        message: "Longitude must be between -180 and 180.",
      })
      continue
    }

    const key = name.toLowerCase()
    if (existingNames.has(key) || seenInBatch.has(key)) {
      result.skipped += 1
      continue
    }

    // Only pass coords if BOTH are present — a half-set pin is useless.
    const hasBothCoords = latitude != null && longitude != null

    try {
      await organizationRepository.createManualProject({
        organizationId: input.organizationId,
        name,
        location,
        latitude: hasBothCoords ? latitude : undefined,
        longitude: hasBothCoords ? longitude : undefined,
      })
      seenInBatch.add(key)
      result.imported += 1
    } catch (err) {
      result.errors.push({
        row: lineNumber,
        message: err instanceof Error ? err.message : "Failed to insert row.",
      })
    }
  }

  return result
}
