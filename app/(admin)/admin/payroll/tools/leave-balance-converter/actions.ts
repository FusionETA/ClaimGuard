"use server"

import { isAdminRole } from "@/lib/auth/types"
import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import {
  convertPandaRows,
  parsePayrollPandaSheet,
} from "@/modules/leave/domain/payroll-panda-balances"
import { getLeaveMigrationRefData } from "@/modules/leave/application/services/leave-migration-ref.service"

import type { ConvertResponse } from "./types"

/**
 * TEMPORARY migration tool — see the page component for scope.
 *
 * Reads a Payroll Panda "Time Off Balances" workbook and converts it to
 * the AltomateHR leave-balance import shape. Nothing is written to the
 * database here: the admin reviews the preview, downloads a CSV, and
 * feeds it to the existing importer at Leave → Import. Keeping the two
 * steps separate means a bad name match is caught by a human before it
 * becomes an entitlement row.
 */

export async function convertPayrollPandaBalancesAction(
  formData: FormData,
): Promise<ConvertResponse> {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return { ok: false, message: "Session expired. Please log in again." }
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) return { ok: false, message: "No active organisation." }

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Choose a Payroll Panda .xlsx export first." }
  }
  if (file.size > 5 * 1024 * 1024) {
    return { ok: false, message: "File too large (max 5 MB)." }
  }

  const includeEmptyRows = formData.get("includeEmptyRows") === "on"

  let workbook: import("xlsx").WorkBook
  try {
    const XLSX = await import("xlsx")
    workbook = XLSX.read(await file.arrayBuffer(), { type: "array" })
  } catch {
    return {
      ok: false,
      message: "Couldn't read that file. Upload the .xlsx exactly as Payroll Panda exported it.",
    }
  }

  const XLSX = await import("xlsx")
  // Read RAW values so dates stay Excel serials. Letting SheetJS format
  // them yields locale-dependent text ("24 Jul 2026") that has to be
  // re-parsed, which is how the as-at date can drift by a day.
  const gridFor = (name: string): string[][] =>
    (
      XLSX.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1,
        blankrows: false,
        defval: "",
        raw: true,
      }) as unknown[][]
    ).map((row) => row.map((c) => String(c ?? "")))

  // Payroll Panda ships a Days sheet and an Hours sheet; usually only
  // one has members. Prefer whichever actually parses to rows, favouring
  // Days because HR leave balances are denominated in days.
  const candidates = workbook.SheetNames.map((name) => ({
    name,
    parsed: parsePayrollPandaSheet(gridFor(name)),
  }))
  const usable = candidates.filter((c) => c.parsed.rows.length > 0)
  const chosen =
    usable.find((c) => c.parsed.unit === "DAYS") ?? usable[0] ?? null

  if (!chosen) {
    const why = candidates[0]?.parsed.problems[0]
    return {
      ok: false,
      message:
        why ??
        "No Time Off Balances data found in that workbook. Check you exported the balances report.",
    }
  }

  const problems = [...chosen.parsed.problems]
  if (chosen.parsed.unit === "HOURS") {
    problems.push(
      "This sheet is in HOURS. AltomateHR tracks leave in days, so these figures need dividing by the working day length before import — export the Days version instead if you can.",
    )
  }

  const { employees, leaveTypes } = await getLeaveMigrationRefData(orgId)

  const year =
    chosen.parsed.cycleYear ??
    (chosen.parsed.asAtDate
      ? Number(chosen.parsed.asAtDate.slice(0, 4))
      : new Date().getUTCFullYear())

  const rows = convertPandaRows({
    rows: chosen.parsed.rows,
    employees,
    leaveTypes,
    year,
    includeEmptyRows,
  })

  const ready = rows.filter((r) => r.status === "READY").length
  return {
    ok: true,
    message: `Converted ${ready} of ${rows.length} rows.`,
    data: {
      companyName: chosen.parsed.companyName,
      asAtDate: chosen.parsed.asAtDate,
      unit: chosen.parsed.unit,
      memberCount: chosen.parsed.memberCount,
      year,
      sheetName: chosen.name,
      otherSheets: workbook.SheetNames.filter((n) => n !== chosen.name),
      rows,
      problems,
    },
  }
}
