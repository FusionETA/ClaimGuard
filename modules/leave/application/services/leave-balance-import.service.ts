import "server-only"

import { bustLeaveCaches } from "@/lib/cache-invalidation"
import { ensureEntitlement } from "@/modules/leave/application/services/leave-entitlements.service"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"

/**
 * Bulk-import current leave BALANCES — the lightweight migration path (e.g.
 * a Jibble / Payroll Panda "Time Off Balances" export). Each row SETS one
 * employee's entitlement for a leave type + year: entitled days,
 * carry-forward, and days already taken. The derived balance
 * (`entitled + carried − used − pending`) then matches the old system
 * without needing every past application on record.
 *
 * This is the simple alternative to `bulkImportLeaveHistory`: use balances
 * when you only want the closing figures, history when you want the full
 * per-application detail. Writes are authoritative (overwrite), so a
 * re-upload just re-sets the same values — safe to re-run.
 */

export const LEAVE_BALANCE_COLUMNS = [
  { key: "employeeEmail", label: "Employee Email", required: true, example: "ahmad@company.com" },
  { key: "leaveType", label: "Leave Type", required: true, example: "Annual Leave" },
  { key: "year", label: "Year", required: false, example: "2026" },
  { key: "entitled", label: "Entitled Days", required: true, example: "14" },
  { key: "carriedForward", label: "Carried Forward", required: false, example: "2" },
  { key: "taken", label: "Taken", required: false, example: "5" },
] as const

export type LeaveBalanceImportResult = {
  imported: number
  failed: number
  errors: Array<{ row: number; message: string }>
}

function normalise(h: string): string {
  return h.trim().replace(/^\*/, "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

// normalise(key OR label) → canonical key.
const HEADER_ALIAS: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const c of LEAVE_BALANCE_COLUMNS) {
    map.set(normalise(c.key), c.key)
    map.set(normalise(c.label), c.key)
  }
  // Friendly aliases for common export headers (e.g. Jibble columns).
  map.set(normalise("carry forward"), "carriedForward")
  map.set(normalise("carried"), "carriedForward")
  map.set(normalise("entitled"), "entitled")
  map.set(normalise("balance taken"), "taken")
  return map
})()

/** Non-negative number from a cell, defaulting when blank. */
function parseDays(raw: string, fallback: number | null): number | null {
  const s = raw.trim()
  if (!s) return fallback
  const n = Number(s.replace(/,/g, ""))
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

export async function bulkImportLeaveBalances(input: {
  orgId: string
  rows: string[][]
  /// "Balances as at" effective date (ISO YYYY-MM-DD) — the cutoff the
  /// imported figures are accurate to. Stamped on each entitlement; the
  /// "Taken" figure is treated as the OPENING used up to this date.
  asAtDate?: string | null
}): Promise<LeaveBalanceImportResult> {
  const result: LeaveBalanceImportResult = { imported: 0, failed: 0, errors: [] }
  const asAtRaw = input.asAtDate?.trim() || null
  const asAt = asAtRaw ? new Date(asAtRaw) : null
  if (asAtRaw && Number.isNaN(asAt!.getTime())) {
    result.errors.push({ row: 0, message: "The 'balances as at' date is invalid." })
    return result
  }
  const rows = input.rows.filter((r) => r.some((c) => c.trim().length > 0))
  if (rows.length < 2) {
    result.errors.push({ row: 0, message: "The file has no data rows." })
    return result
  }

  const header = rows[0]
  const colIndex = new Map<string, number>()
  header.forEach((cell, i) => {
    const key = HEADER_ALIAS.get(normalise(cell))
    if (key) colIndex.set(key, i)
  })
  const missing = LEAVE_BALANCE_COLUMNS.filter(
    (c) => c.required && !colIndex.has(c.key),
  ).map((c) => c.label)
  if (missing.length > 0) {
    result.errors.push({
      row: 0,
      message: `Missing required column(s): ${missing.join(", ")}.`,
    })
    return result
  }

  const employees = await leaveRepository.listEmployeesForLeaveSettings(input.orgId)
  const empByEmail = new Map(
    employees.map((e) => [e.email.trim().toLowerCase(), e.id]),
  )
  const types = await leaveRepository.listTypes(input.orgId, {
    includeArchived: true,
  })
  const typeByName = new Map<string, string>()
  for (const t of types) {
    typeByName.set(t.name.trim().toLowerCase(), t.id)
    typeByName.set(t.code.trim().toLowerCase(), t.id)
  }

  const cell = (row: string[], key: string): string =>
    (row[colIndex.get(key) ?? -1] ?? "").trim()

  const currentYear = new Date().getUTCFullYear()

  for (let i = 1; i < rows.length; i++) {
    const rowNumber = i // 1-based data row (header is row 0)
    const row = rows[i]
    try {
      const emailRaw = cell(row, "employeeEmail")
      const employeeId = empByEmail.get(emailRaw.toLowerCase())
      if (!employeeId) {
        throw new Error(`No employee with email "${emailRaw}" in this org.`)
      }

      const typeRaw = cell(row, "leaveType")
      const leaveTypeId = typeByName.get(typeRaw.toLowerCase())
      if (!leaveTypeId) {
        throw new Error(`Unknown leave type "${typeRaw}".`)
      }

      const yearRaw = cell(row, "year")
      const year = yearRaw ? Number(yearRaw) : currentYear
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        throw new Error("Year must be a 4-digit year (e.g. 2026).")
      }

      const entitled = parseDays(cell(row, "entitled"), null)
      if (entitled === null) {
        throw new Error("Entitled Days must be a number ≥ 0.")
      }
      const carried = parseDays(cell(row, "carriedForward"), 0)
      if (carried === null) {
        throw new Error("Carried Forward must be a number ≥ 0.")
      }
      const taken = parseDays(cell(row, "taken"), 0)
      if (taken === null) {
        throw new Error("Taken must be a number ≥ 0.")
      }

      // Ensure the entitlement row exists (via the safe creation path),
      // then overwrite its balance figures with the migrated values.
      // `accruedDays` mirrors entitled so the full quota is immediately
      // available post-migration (matches "here's their balance now").
      const entitlement = await ensureEntitlement(employeeId, leaveTypeId, year)
      await leaveRepository.setEntitlementBalances(entitlement.id, {
        entitledDays: entitled,
        carriedDays: carried,
        accruedDays: entitled,
        // "Taken" is the OPENING used as at the cutoff — added on top of
        // any usage tracked since (never overwrites post-cutoff leave).
        openingUsedDays: taken,
        balanceAsAt: asAt,
      })

      result.imported += 1
    } catch (err) {
      result.failed += 1
      result.errors.push({
        row: rowNumber,
        message: err instanceof Error ? err.message : "Could not import row.",
      })
    }
  }

  await bustLeaveCaches({ organizationId: input.orgId })
  return result
}
