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
  { key: "employeeName", label: "Employee Name", required: true, example: "Ahmad Ali" },
  { key: "employeeEmail", label: "Employee Email", required: false, example: "ahmad@company.com" },
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

/**
 * Normalise a person's name for tolerant matching: strip accents, lower-
 * case, and reduce every run of non-alphanumerics to a single space. So a
 * Jibble "AHMAD  BIN ALI" lines up with an AltomateHR "Ahmad bin Ali".
 */
function normaliseName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
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
  // Name is the primary identity column (Jibble exports names, not emails).
  map.set(normalise("name"), "employeeName")
  map.set(normalise("full name"), "employeeName")
  map.set(normalise("employee"), "employeeName")
  map.set(normalise("member"), "employeeName")
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
  // Identity is interchangeable: Employee Name (primary) OR Employee Email
  // (optional tie-breaker) — at least one of the two columns must exist.
  if (!colIndex.has("employeeName") && !colIndex.has("employeeEmail")) {
    result.errors.push({
      row: 0,
      message: "Add an 'Employee Name' column (Email is optional).",
    })
    return result
  }
  const missing = LEAVE_BALANCE_COLUMNS.filter(
    (c) => c.required && c.key !== "employeeName" && !colIndex.has(c.key),
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
  // Name → ids (plural: names aren't unique, so we detect collisions and
  // make the admin disambiguate with an email rather than guessing).
  const empIdsByName = new Map<string, string[]>()
  for (const e of employees) {
    const key = normaliseName(e.name)
    if (!key) continue
    const bucket = empIdsByName.get(key)
    if (bucket) bucket.push(e.id)
    else empIdsByName.set(key, [e.id])
  }
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
      // Resolve the employee: email wins when given (exact + unambiguous),
      // otherwise match by name. A name that hits nobody — or more than one
      // person — fails the row rather than risk assigning to the wrong
      // staff and silently corrupting their balance.
      const nameRaw = cell(row, "employeeName")
      const emailRaw = cell(row, "employeeEmail")
      let employeeId: string | undefined
      if (emailRaw) {
        employeeId = empByEmail.get(emailRaw.toLowerCase())
        if (!employeeId) {
          throw new Error(`No employee with email "${emailRaw}" in this org.`)
        }
      } else if (nameRaw) {
        const ids = empIdsByName.get(normaliseName(nameRaw)) ?? []
        if (ids.length === 0) {
          throw new Error(`No employee named "${nameRaw}" in this org.`)
        }
        if (ids.length > 1) {
          throw new Error(
            `Multiple employees named "${nameRaw}" — add their email in the Employee Email column to pick one.`,
          )
        }
        employeeId = ids[0]
      } else {
        throw new Error("Row is missing both employee name and email.")
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
