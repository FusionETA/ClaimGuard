"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { applyLeaveOnBehalfOfEmployee } from "@/modules/leave/application/services/leave-application.service"
import {
  bulkImportLeaveHistory,
  type LeaveHistoryImportResult,
} from "@/modules/leave/application/services/leave-history-import.service"

/**
 * Admin-only: file a leave application on behalf of an employee.
 *
 * Used when an employee tells the admin verbally / over chat that they
 * need a day off and the admin keys it in rather than asking the
 * employee to log into the portal. Lands as APPROVED (skips supervisor
 * approval — the admin already has authority) and decrements the
 * employee's entitlement balance.
 *
 * Returns a plain `{ ok, message }` so the caller can render an inline
 * toast via the useTransition + useToast pattern (mirrors the
 * sync-claim action shape — no useActionState here because the form
 * lives in a dialog and we want to close it on success).
 */
const schema = z.object({
  employeeProfileId: z.string().min(1, "Pick an employee."),
  leaveTypeId: z.string().min(1, "Pick a leave type."),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date."),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an end date."),
  duration: z.enum(["FULL_DAY", "MORNING", "AFTERNOON"]).default("FULL_DAY"),
  reason: z.string().trim().max(2000).optional(),
})

export async function applyLeaveOnBehalfAction(input: {
  employeeProfileId: string
  leaveTypeId: string
  /// yyyy-mm-dd
  startDate: string
  /// yyyy-mm-dd
  endDate: string
  duration: "FULL_DAY" | "MORNING" | "AFTERNOON"
  reason?: string
}): Promise<{ ok: boolean; message: string }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, message: "No active organisation." }

  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid input.",
    }
  }

  // Parse the yyyy-mm-dd to a UTC date so the working-days math stays
  // consistent with the employee-self path (which receives Dates the
  // same way upstream).
  const startDate = parseIsoDate(parsed.data.startDate)
  const endDate = parseIsoDate(parsed.data.endDate)
  if (!startDate || !endDate) {
    return { ok: false, message: "Invalid date format." }
  }

  const result = await applyLeaveOnBehalfOfEmployee({
    adminUserId: session.userId,
    payload: {
      employeeProfileId: parsed.data.employeeProfileId,
      leaveTypeId: parsed.data.leaveTypeId,
      startDate,
      endDate,
      duration: parsed.data.duration,
      reason: parsed.data.reason ?? null,
    },
  })
  if (!result.ok) {
    return { ok: false, message: result.error }
  }

  revalidatePath("/admin/leave")
  revalidatePath("/admin/leave/balances")
  revalidatePath("/employee/leave")
  return {
    ok: true,
    message: `Applied ${result.totalDays} day(s) of leave on behalf of the employee.`,
  }
}

function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return new Date(Date.UTC(y, mo - 1, d))
}

/**
 * Admin-only: bulk-import historical leave applications (migration from
 * another HR/attendance system). Accepts the styled `.xlsx` template or a
 * CSV. Delegates the per-row parsing + validation + idempotency to the
 * service; here we just gate the session, read the file into rows, and
 * summarise.
 */
export async function importLeaveHistoryAction(
  formData: FormData,
): Promise<{ ok: boolean; message: string; result?: LeaveHistoryImportResult }> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, message: "No active organisation." }

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "No file uploaded." }
  }
  if (file.size > 5 * 1024 * 1024) {
    return { ok: false, message: "File too large (max 5 MB). Split into batches." }
  }

  let rows: string[][]
  try {
    rows = await fileToRows(file)
  } catch {
    return {
      ok: false,
      message: "Could not read the file. Upload the .xlsx template or a CSV.",
    }
  }

  const result = await bulkImportLeaveHistory({
    orgId,
    adminUserId: session.userId,
    rows,
  })

  revalidatePath("/admin/leave")
  revalidatePath("/admin/leave/balances")
  revalidatePath("/employee/leave")

  const ok = result.imported > 0 || (result.failed === 0 && result.errors.length === 0)
  const parts = [`Imported ${result.imported}`]
  if (result.skipped) parts.push(`skipped ${result.skipped} already-imported`)
  if (result.failed) parts.push(`${result.failed} failed`)
  return { ok, message: parts.join(", ") + ".", result }
}

/// Read an uploaded leave-history file into rows. `.xlsx` (the template)
/// is read via ExcelJS — the "Leave History" sheet (or first data sheet);
/// otherwise the text is parsed as CSV. Non-exported: "use server" files
/// only export async functions.
async function fileToRows(file: File): Promise<string[][]> {
  const isXlsx =
    file.name.toLowerCase().endsWith(".xlsx") ||
    file.type.includes("spreadsheetml") ||
    file.type.includes("ms-excel")
  if (isXlsx) {
    const ExcelJS = (await import("exceljs")).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await file.arrayBuffer())
    const ws =
      wb.getWorksheet("Leave History") ??
      wb.worksheets.find(
        (s) => !/read ?me|instruction|example|sample/i.test(s.name),
      ) ??
      wb.worksheets[0]
    if (!ws) return []
    const colCount = ws.columnCount
    const rows: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = []
      for (let c = 1; c <= colCount; c++) {
        cells.push(String(row.getCell(c).text ?? ""))
      }
      rows.push(cells)
    })
    return rows
  }
  return parseCsvText(await file.text())
}

/// Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). Enough for
/// hand-saved CSVs; the primary path is the XLSX template.
function parseCsvText(text: string): string[][] {
  const t = text.replace(/^﻿/, "")
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (inQuotes) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (ch !== "\r") field += ch
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0))
}
