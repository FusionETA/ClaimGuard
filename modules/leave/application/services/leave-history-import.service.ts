import "server-only"

import { bustLeaveCaches } from "@/lib/cache-invalidation"
import { ensureEntitlement } from "@/modules/leave/application/services/leave-entitlements.service"
import { leaveRepository } from "@/modules/leave/infrastructure/leave-repository"

/**
 * Bulk-import historical leave applications (a migration from another
 * system, e.g. Jibble / Payroll Panda). Each row becomes a
 * `LeaveApplication` tagged as admin-applied. APPROVED rows also bump the
 * employee's stored `usedDays` so the derived balance
 * (`entitled + carried − used − pending`) reflects the imported history —
 * this is the "used" side of the migration; the entitlement config
 * (annual days, carry-forward) is set separately.
 *
 * Unlike the interactive on-behalf path, this deliberately:
 *   - honours the row's status (APPROVED / PENDING / REJECTED / CANCELLED),
 *   - trusts the source `Days` figure instead of recomputing working days,
 *   - skips the balance-sufficiency gate (the leave already happened),
 *   - is idempotent — a row already imported (same employee + type + exact
 *     dates) is skipped, so a re-run never double-counts.
 */

export const LEAVE_HISTORY_COLUMNS = [
  { key: "employeeName", label: "Employee Name", required: true, example: "Ahmad Ali" },
  { key: "employeeEmail", label: "Employee Email", required: false, example: "ahmad@company.com" },
  { key: "leaveType", label: "Leave Type", required: true, example: "Annual Leave" },
  { key: "startDate", label: "Start Date", required: true, example: "2026-01-15" },
  { key: "endDate", label: "End Date", required: true, example: "2026-01-16" },
  { key: "days", label: "Days", required: true, example: "2" },
  { key: "status", label: "Status", required: true, example: "APPROVED" },
  { key: "reason", label: "Reason", required: false, example: "Family matter" },
] as const

type LeaveStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"
const VALID_STATUSES: readonly LeaveStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]

export type LeaveHistoryImportResult = {
  imported: number
  skipped: number
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
  for (const c of LEAVE_HISTORY_COLUMNS) {
    map.set(normalise(c.key), c.key)
    map.set(normalise(c.label), c.key)
  }
  // Name is the primary identity column (Jibble exports names, not emails).
  map.set(normalise("name"), "employeeName")
  map.set(normalise("full name"), "employeeName")
  map.set(normalise("employee"), "employeeName")
  map.set(normalise("member"), "employeeName")
  return map
})()

function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return new Date(Date.UTC(y, mo - 1, d))
}

export async function bulkImportLeaveHistory(input: {
  orgId: string
  adminUserId: string
  rows: string[][]
}): Promise<LeaveHistoryImportResult> {
  const result: LeaveHistoryImportResult = {
    imported: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  }
  const rows = input.rows.filter((r) => r.some((c) => c.trim().length > 0))
  if (rows.length < 2) {
    result.errors.push({ row: 0, message: "The file has no data rows." })
    return result
  }

  // Header → column index (accepts friendly label or key).
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
  const missing = LEAVE_HISTORY_COLUMNS.filter(
    (c) => c.required && c.key !== "employeeName" && !colIndex.has(c.key),
  ).map((c) => c.label)
  if (missing.length > 0) {
    result.errors.push({
      row: 0,
      message: `Missing required column(s): ${missing.join(", ")}.`,
    })
    return result
  }

  // Lookups: employee by email, leave type by name OR code (archived
  // included so historical types still resolve).
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

      const startDate = parseIsoDate(cell(row, "startDate"))
      const endDate = parseIsoDate(cell(row, "endDate"))
      if (!startDate || !endDate) {
        throw new Error("Start/End Date must be YYYY-MM-DD.")
      }
      if (endDate < startDate) {
        throw new Error("End Date is before Start Date.")
      }

      const totalDays = Number(cell(row, "days"))
      if (!Number.isFinite(totalDays) || totalDays <= 0) {
        throw new Error("Days must be a positive number.")
      }

      const statusRaw = cell(row, "status").toUpperCase() as LeaveStatus
      if (!VALID_STATUSES.includes(statusRaw)) {
        throw new Error(
          `Status must be one of ${VALID_STATUSES.join(" / ")}.`,
        )
      }
      const reason = cell(row, "reason") || null

      // Idempotency: skip a row that was already imported.
      const existing = await leaveRepository.findMatchingApplicationId({
        employeeId,
        leaveTypeId,
        startDate,
        endDate,
      })
      if (existing) {
        result.skipped += 1
        continue
      }

      const decided = statusRaw !== "PENDING"
      const duration = totalDays === 0.5 ? "MORNING" : "FULL_DAY"

      await leaveRepository.createApplication({
        employeeId,
        leaveTypeId,
        startDate,
        endDate,
        duration,
        totalDays,
        reason,
        attachmentUrl: null,
        attachmentName: null,
        xeroFileId: null,
        status: statusRaw,
        currentStep: 0,
        decidedAt: decided ? new Date() : null,
        appliedByAdminId: input.adminUserId,
        approvals:
          statusRaw === "APPROVED"
            ? [
                {
                  step: 0,
                  approverId: input.adminUserId,
                  decidedAt: new Date().toISOString(),
                  decision: "APPROVED",
                  ...(reason ? { notes: reason } : {}),
                },
              ]
            : null,
      })

      // Only APPROVED leave consumes the stored `usedDays` balance.
      // PENDING is reflected via the read-time pending sum; REJECTED /
      // CANCELLED don't touch the balance.
      if (statusRaw === "APPROVED") {
        const entitlement = await ensureEntitlement(
          employeeId,
          leaveTypeId,
          startDate.getUTCFullYear(),
        )
        await leaveRepository.addUsedDays(entitlement.id, totalDays)
      }

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
