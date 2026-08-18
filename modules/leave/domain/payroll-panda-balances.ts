/**
 * Payroll Panda "Time Off Balances" → AltomateHR leave-balance template.
 *
 * TEMPORARY MIGRATION TOOL. Delete this file, its test, and
 * `app/(admin)/admin/payroll/tools/leave-balance-converter/` once the
 * Payroll Panda migrations are done.
 *
 * Pure domain — no I/O, no Prisma. The route action reads the workbook
 * into a string grid and hands it here, so every awkward part of the
 * conversion is unit-testable.
 *
 * ## The source shape
 *
 * Payroll Panda exports two sheets, "… - (Hours)" and "… - (Days)", of
 * which usually only one is populated. Above the table sit four metadata
 * rows (title + company, `Date As Of`, `Unit`, `# Members`), then a
 * header row, then one row per (employee × leave policy):
 *
 *     FULL NAME | MEMBER CODE | GROUP | TIME OFF POLICY | CYCLE START |
 *     CYCLE END | COMPENSATION | CARRY FORWARD | ENTITLED |
 *     AMENDMENTS | TAKEN | BALANCE
 *
 * `FULL NAME` / `MEMBER CODE` / `GROUP` appear ONLY on an employee's
 * first row — the rest of their block leaves them blank — so identity
 * has to be forward-filled or every row after the first is orphaned.
 *
 * ## What doesn't line up
 *
 *  - **No email.** The HR importer keys on `Employee Email` and rejects
 *    a row whose email it can't resolve. Payroll Panda only gives a name
 *    and its own member code, so names are matched against the org's
 *    employees here — and anything ambiguous is reported rather than
 *    guessed. Writing a balance onto the wrong person is far worse than
 *    making someone fix a row by hand.
 *  - **`AMENDMENTS` has no HR column.** It's an adjustment to the
 *    quota, so it's folded into Entitled Days, which keeps
 *    `entitled + carried − taken` equal to Payroll Panda's `BALANCE`.
 *  - **`TAKEN` can be negative** (an adjustment granting days back).
 *    The HR importer rejects a negative Taken, so it's folded into
 *    Entitled Days instead — same resulting balance, valid input.
 */

export type PandaSourceRow = {
  /// 1-based row number in the source sheet, for error messages that
  /// the admin can act on without counting rows themselves.
  sheetRow: number
  fullName: string
  memberCode: string
  policy: string
  carriedForward: number
  entitled: number
  amendments: number
  taken: number
  balance: number
}

export type PandaSheet = {
  companyName: string | null
  /// ISO date from the `Date As Of` metadata row. Feeds the leave
  /// import's "balances as at" field, which decides how the Taken
  /// figure is treated.
  asAtDate: string | null
  unit: "DAYS" | "HOURS" | null
  memberCount: number | null
  /// Year taken from `CYCLE END` (falling back to `CYCLE START`).
  cycleYear: number | null
  rows: PandaSourceRow[]
  problems: string[]
}

export type ConvertedStatus =
  | "READY"
  | "NO_EMAIL_MATCH"
  | "AMBIGUOUS_NAME"
  | "UNKNOWN_LEAVE_TYPE"
  | "EMPTY"

export type ConvertedRow = {
  sheetRow: number
  fullName: string
  memberCode: string
  policy: string
  email: string | null
  leaveTypeName: string | null
  year: number
  entitled: number
  carriedForward: number
  taken: number
  status: ConvertedStatus
  /// Human-readable record of every adjustment applied, shown in the
  /// preview so nothing is silently rewritten.
  notes: string[]
}

// ── Parsing ────────────────────────────────────────────────────────────

function cellText(row: string[] | undefined, i: number): string {
  return (row?.[i] ?? "").toString().trim()
}

function toNumber(raw: string): number {
  const s = raw.replace(/,/g, "").trim()
  if (!s) return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/**
 * Excel serial / common date strings → ISO `YYYY-MM-DD`.
 * Payroll Panda writes `Date As Of` and the cycle bounds as serials;
 * a workbook re-saved by Excel or Sheets may render them as text
 * instead, so both are accepted. Returns null when unrecognised rather
 * than guessing a date.
 */
export function toIsoDate(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)

  // Excel serial (days since 1899-12-30). Bounded to a plausible range
  // so a stray "8" isn't read as a date in 1900.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s)
    if (serial > 20000 && serial < 80000) {
      const ms = (serial - 25569) * 86400000
      const d = new Date(ms)
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
    }
    return null
  }

  // Slash/dash dates. Day-first by default (Malaysian export), but a
  // component over 12 settles it either way — "23/07" can only be
  // day-first, "07/23" can only be month-first.
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s)
  if (m) {
    const first = Number(m[1])
    const second = Number(m[2])
    const y = m[3]
    const monthFirst = first <= 12 && second > 12
    const day = monthFirst ? second : first
    const month = monthFirst ? first : second
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    }
    return null
  }

  // Textual dates from a re-saved workbook ("24 Jul 2026").
  //
  // Read back the LOCAL calendar components, NOT `toISOString()`: a bare
  // date string parses to local midnight, so in UTC+8 the ISO form is
  // the PREVIOUS day. That silently shifted the "balances as at" cutoff
  // by one day, which changes how the importer treats the Taken figure.
  const parsed = new Date(s)
  if (Number.isNaN(parsed.getTime())) return null
  const yy = parsed.getFullYear()
  const mm = String(parsed.getMonth() + 1).padStart(2, "0")
  const dd = String(parsed.getDate()).padStart(2, "0")
  return `${yy}-${mm}-${dd}`
}

const HEADER_KEYS = [
  "fullName",
  "memberCode",
  "group",
  "policy",
  "cycleStart",
  "cycleEnd",
  "compensation",
  "carriedForward",
  "entitled",
  "amendments",
  "taken",
  "balance",
] as const
type HeaderKey = (typeof HEADER_KEYS)[number]

const HEADER_LABELS: Record<HeaderKey, string> = {
  fullName: "full name",
  memberCode: "member code",
  group: "group",
  policy: "time off policy",
  cycleStart: "cycle start",
  cycleEnd: "cycle end",
  compensation: "compensation",
  carriedForward: "carry forward",
  entitled: "entitled",
  amendments: "amendments",
  taken: "taken",
  balance: "balance",
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Read one Payroll Panda sheet (already a string grid) into structured
 * rows. Tolerant of the metadata block above the table and of the
 * merged-looking employee blocks below it.
 */
export function parsePayrollPandaSheet(grid: string[][]): PandaSheet {
  const problems: string[] = []

  const headerIndex = grid.findIndex((row) => {
    const cells = row.map(norm)
    return (
      cells.includes("full name") && cells.includes("time off policy")
    )
  })

  if (headerIndex === -1) {
    return {
      companyName: null,
      asAtDate: null,
      unit: null,
      memberCount: null,
      cycleYear: null,
      rows: [],
      problems: [
        "Couldn't find the Payroll Panda header row (expected columns 'FULL NAME' and 'TIME OFF POLICY'). Is this the Time Off Balances export?",
      ],
    }
  }

  const headerRow = grid[headerIndex].map(norm)
  const col = {} as Record<HeaderKey, number>
  for (const key of HEADER_KEYS) {
    col[key] = headerRow.indexOf(HEADER_LABELS[key])
  }
  const requiredMissing = (
    ["fullName", "policy", "entitled", "taken"] as HeaderKey[]
  ).filter((k) => col[k] === -1)
  if (requiredMissing.length > 0) {
    problems.push(
      `Missing expected column(s): ${requiredMissing
        .map((k) => HEADER_LABELS[k])
        .join(", ")}.`,
    )
  }

  // Metadata sits above the header row as label/value pairs.
  let companyName: string | null = null
  let asAtDate: string | null = null
  let unit: "DAYS" | "HOURS" | null = null
  let memberCount: number | null = null
  for (let i = 0; i < headerIndex; i++) {
    const row = grid[i] ?? []
    const label = norm(cellText(row, 0))
    if (label === "date as of") asAtDate = toIsoDate(cellText(row, 1))
    else if (label === "unit") {
      const v = norm(cellText(row, 1))
      unit = v === "days" ? "DAYS" : v === "hours" ? "HOURS" : null
    } else if (label === "# members") {
      const n = Number(cellText(row, 1))
      memberCount = Number.isFinite(n) ? n : null
    }
    if (!companyName) {
      // The company sits in a trailing cell of the title row rather
      // than beside a label, so take the last non-empty cell that
      // isn't the report title itself.
      const trailing = row
        .map((c) => (c ?? "").toString().trim())
        .filter((c) => c && norm(c) !== "time off balances")
      if (i === 0 && trailing.length > 0) {
        companyName = trailing[trailing.length - 1]
      }
    }
  }

  const rows: PandaSourceRow[] = []
  let currentName = ""
  let currentCode = ""
  let cycleYear: number | null = null

  for (let i = headerIndex + 1; i < grid.length; i++) {
    const row = grid[i]
    if (!row || row.every((c) => !(c ?? "").toString().trim())) continue

    // Identity appears only on an employee's first row — carry it down.
    const name = cellText(row, col.fullName)
    if (name) {
      currentName = name
      currentCode = col.memberCode === -1 ? "" : cellText(row, col.memberCode)
    }

    const policy = col.policy === -1 ? "" : cellText(row, col.policy)
    if (!policy) continue

    if (cycleYear === null) {
      const end =
        col.cycleEnd === -1 ? null : toIsoDate(cellText(row, col.cycleEnd))
      const start =
        col.cycleStart === -1 ? null : toIsoDate(cellText(row, col.cycleStart))
      const iso = end ?? start
      if (iso) cycleYear = Number(iso.slice(0, 4))
    }

    rows.push({
      sheetRow: i + 1,
      fullName: currentName,
      memberCode: currentCode,
      policy,
      carriedForward:
        col.carriedForward === -1 ? 0 : toNumber(cellText(row, col.carriedForward)),
      entitled: col.entitled === -1 ? 0 : toNumber(cellText(row, col.entitled)),
      amendments:
        col.amendments === -1 ? 0 : toNumber(cellText(row, col.amendments)),
      taken: col.taken === -1 ? 0 : toNumber(cellText(row, col.taken)),
      balance: col.balance === -1 ? 0 : toNumber(cellText(row, col.balance)),
    })
  }

  if (rows.some((r) => !r.fullName)) {
    problems.push(
      "Some rows have no employee name above them — the export may be missing its first employee block.",
    )
  }

  return {
    companyName,
    asAtDate,
    unit,
    memberCount,
    cycleYear,
    rows,
    problems,
  }
}

// ── Conversion ─────────────────────────────────────────────────────────

/**
 * Normalise a person's name for matching. Case, punctuation and repeated
 * whitespace vary constantly between systems ("Nurul Athirah Binti
 * Aizan" vs "NURUL ATHIRAH BT. AIZAN"), so all three are flattened —
 * but nothing is reordered or abbreviated, because a looser match risks
 * pairing two different people.
 */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'`]/g, "")
    .replace(/[^a-z0-9\s@-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/// Round to 4dp to strip binary-float noise (Payroll Panda emits values
/// like 7.3333333333) without materially changing a day count.
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

export function convertPandaRows(input: {
  rows: PandaSourceRow[]
  /// The org's employees, for name → email resolution.
  employees: Array<{ name: string; email: string }>
  /// The org's leave types; matched on name or code, mirroring what the
  /// HR importer itself accepts.
  leaveTypes: Array<{ name: string; code: string }>
  year: number
  /// Rows with nothing in any figure are noise from Payroll Panda
  /// listing every policy for every employee. Excluded by default.
  includeEmptyRows?: boolean
}): ConvertedRow[] {
  const byName = new Map<string, string[]>()
  for (const e of input.employees) {
    const key = normaliseName(e.name)
    if (!key) continue
    const list = byName.get(key)
    if (list) list.push(e.email)
    else byName.set(key, [e.email])
  }

  const typeByKey = new Map<string, string>()
  for (const t of input.leaveTypes) {
    typeByKey.set(normaliseName(t.name), t.name)
    typeByKey.set(normaliseName(t.code), t.name)
  }

  return input.rows.map((row) => {
    const notes: string[] = []

    let entitled = row.entitled
    let carried = row.carriedForward
    let taken = row.taken

    if (row.amendments !== 0) {
      entitled += row.amendments
      notes.push(
        `Amendments ${row.amendments > 0 ? "+" : ""}${row.amendments} folded into Entitled (no HR column).`,
      )
    }
    if (taken < 0) {
      entitled += -taken
      notes.push(
        `Negative Taken (${taken}) folded into Entitled — HR rejects a negative Taken.`,
      )
      taken = 0
    }
    if (carried < 0) {
      entitled += carried
      notes.push(
        `Negative Carry Forward (${carried}) folded into Entitled — HR rejects a negative value.`,
      )
      carried = 0
    }
    if (entitled < 0) {
      notes.push(
        `Entitled came out negative (${round4(entitled)}) after adjustments; clamped to 0 — check this one by hand.`,
      )
      entitled = 0
    }

    entitled = round4(entitled)
    carried = round4(carried)
    taken = round4(taken)

    const base = {
      sheetRow: row.sheetRow,
      fullName: row.fullName,
      memberCode: row.memberCode,
      policy: row.policy,
      year: input.year,
      entitled,
      carriedForward: carried,
      taken,
      notes,
    }

    const isEmpty =
      row.entitled === 0 &&
      row.carriedForward === 0 &&
      row.amendments === 0 &&
      row.taken === 0
    if (isEmpty && !input.includeEmptyRows) {
      return {
        ...base,
        email: null,
        leaveTypeName: null,
        status: "EMPTY" as const,
      }
    }

    const leaveTypeName = typeByKey.get(normaliseName(row.policy)) ?? null
    if (!leaveTypeName) {
      notes.push(
        `No AltomateHR leave type matches "${row.policy}". Create it first, or drop the row.`,
      )
      return {
        ...base,
        email: null,
        leaveTypeName: null,
        status: "UNKNOWN_LEAVE_TYPE" as const,
      }
    }

    const matches = byName.get(normaliseName(row.fullName)) ?? []
    if (matches.length === 0) {
      notes.push(
        `No AltomateHR employee named "${row.fullName}". Fill the email in by hand, or skip.`,
      )
      return {
        ...base,
        email: null,
        leaveTypeName,
        status: "NO_EMAIL_MATCH" as const,
      }
    }
    if (matches.length > 1) {
      notes.push(
        `${matches.length} employees share this name (${matches.join(", ")}). Pick one by hand — guessing could credit the wrong person.`,
      )
      return {
        ...base,
        email: null,
        leaveTypeName,
        status: "AMBIGUOUS_NAME" as const,
      }
    }

    return {
      ...base,
      email: matches[0],
      leaveTypeName,
      status: "READY" as const,
    }
  })
}
