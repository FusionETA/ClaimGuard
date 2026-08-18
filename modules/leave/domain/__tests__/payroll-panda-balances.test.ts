import { describe, expect, it } from "vitest"

import {
  convertPandaRows,
  normaliseName,
  parsePayrollPandaSheet,
  toHrBalanceCsv,
  toIsoDate,
} from "@/modules/leave/domain/payroll-panda-balances"

/**
 * Shape of a real Payroll Panda "Time Off Balances" export: four
 * metadata rows, a header row, then employee blocks whose identity
 * columns are filled only on the first row.
 */
const SHEET: string[][] = [
  ["Time Off Balances", "", "", "", "", "", "", "", "", "", "", "ACME SDN. BHD."],
  ["Date As Of", "46227"],
  ["Unit", "Days"],
  ["# Members", "2"],
  [
    "FULL NAME", "MEMBER CODE", "GROUP", "TIME OFF POLICY", "CYCLE START",
    "CYCLE END", "COMPENSATION", "CARRY FORWARD", "ENTITLED", "AMENDMENTS",
    "TAKEN", "BALANCE",
  ],
  ["Chan Yan Yee", "EC017", "MM", "Annual Leave", "46023", "46387", "Paid", "0", "8", "0", "7", "1"],
  ["", "", "", "Medical Leave", "46023", "46387", "Paid", "0", "14", "0", "9", "5"],
  ["", "", "", "Marriage Leave", "46023", "46387", "Paid", "0", "0", "0", "0", "0"],
  ["Hooi Xin Yi", "EC018", "FK", "Annual Leave", "46023", "46387", "Paid", "0", "7.3333333333", "0", "-5", "12.3333333333"],
  ["", "", "", "Time Off In Lieu", "46023", "46387", "Paid", "0", "3", "0", "0", "3"],
]

const EMPLOYEES = [
  { name: "Chan Yan Yee", email: "chan@acme.my" },
  { name: "HOOI XIN YI", email: "hooi@acme.my" },
]

const LEAVE_TYPES = [
  { name: "Annual Leave", code: "ANNUAL" },
  { name: "Medical Leave", code: "MEDICAL" },
  { name: "Marriage Leave", code: "MARRIAGE" },
]

describe("toIsoDate", () => {
  it("converts the Excel serials Payroll Panda writes", () => {
    expect(toIsoDate("46227")).toBe("2026-07-24")
    expect(toIsoDate("46023")).toBe("2026-01-01")
  })
  it("reads day-first strings from a re-saved workbook", () => {
    expect(toIsoDate("24/07/2026")).toBe("2026-07-24")
    // Day-first matters: month-first would make this 8 July.
    expect(toIsoDate("07/08/2026")).toBe("2026-08-07")
  })
  it("uses an out-of-range component to settle day/month order", () => {
    expect(toIsoDate("07/23/2026")).toBe("2026-07-23") // must be month-first
    expect(toIsoDate("23/07/2026")).toBe("2026-07-23") // must be day-first
  })
  it("does not shift a textual date across the timezone boundary", () => {
    // `new Date("24 Jul 2026").toISOString()` is 2026-07-23 in UTC+8.
    // Getting this wrong moves the "balances as at" cutoff by a day.
    expect(toIsoDate("24 Jul 2026")).toBe("2026-07-24")
    expect(toIsoDate("1 Jan 2026")).toBe("2026-01-01")
  })
  it("passes ISO through and rejects nonsense", () => {
    expect(toIsoDate("2026-07-24")).toBe("2026-07-24")
    expect(toIsoDate("")).toBeNull()
    expect(toIsoDate("8")).toBeNull() // a stray number is not a date
  })
})

describe("parsePayrollPandaSheet", () => {
  const parsed = parsePayrollPandaSheet(SHEET)

  it("reads the metadata block above the table", () => {
    expect(parsed.asAtDate).toBe("2026-07-24")
    expect(parsed.unit).toBe("DAYS")
    expect(parsed.memberCount).toBe(2)
    expect(parsed.companyName).toBe("ACME SDN. BHD.")
    expect(parsed.cycleYear).toBe(2026)
  })

  it("forward-fills identity down each employee block", () => {
    expect(parsed.rows).toHaveLength(5)
    expect(parsed.rows.map((r) => r.fullName)).toEqual([
      "Chan Yan Yee",
      "Chan Yan Yee",
      "Chan Yan Yee",
      "Hooi Xin Yi",
      "Hooi Xin Yi",
    ])
    expect(parsed.rows[1].memberCode).toBe("EC017")
  })

  it("reports a file that isn't the expected export", () => {
    const bad = parsePayrollPandaSheet([["Name", "Days"], ["Ali", "5"]])
    expect(bad.rows).toHaveLength(0)
    expect(bad.problems[0]).toContain("header row")
  })
})

describe("convertPandaRows", () => {
  const parsed = parsePayrollPandaSheet(SHEET)
  const rows = convertPandaRows({
    rows: parsed.rows,
    employees: EMPLOYEES,
    leaveTypes: LEAVE_TYPES,
    year: 2026,
  })

  it("matches names case-insensitively", () => {
    expect(rows[3].email).toBe("hooi@acme.my")
  })

  it("folds a negative Taken into Entitled, preserving the balance", () => {
    const r = rows[3] // Hooi, Annual: entitled 7.3333, taken -5
    expect(r.taken).toBe(0)
    expect(r.entitled).toBe(12.3333)
    expect(r.status).toBe("READY")
    expect(r.notes.join(" ")).toContain("Negative Taken")
    // Payroll Panda's BALANCE was 12.3333333333 — entitled − taken agrees.
    expect(r.entitled - r.taken).toBeCloseTo(12.3333, 4)
  })

  it("keeps ordinary rows untouched", () => {
    expect(rows[0]).toMatchObject({
      email: "chan@acme.my",
      leaveTypeName: "Annual Leave",
      entitled: 8,
      taken: 7,
      status: "READY",
    })
  })

  it("drops all-zero rows as noise by default, and keeps them on request", () => {
    expect(rows[2].status).toBe("EMPTY")
    const withEmpty = convertPandaRows({
      rows: parsed.rows,
      employees: EMPLOYEES,
      leaveTypes: LEAVE_TYPES,
      year: 2026,
      includeEmptyRows: true,
    })
    expect(withEmpty[2].status).toBe("READY")
  })

  it("flags a policy with no HR leave type instead of dropping it silently", () => {
    const toil = rows[4]
    expect(toil.status).toBe("UNKNOWN_LEAVE_TYPE")
    expect(toil.notes.join(" ")).toContain("Time Off In Lieu")
  })

  it("refuses to guess when two employees share a name", () => {
    const dupes = convertPandaRows({
      rows: parsed.rows,
      employees: [
        { name: "Chan Yan Yee", email: "chan1@acme.my" },
        { name: "chan yan yee", email: "chan2@acme.my" },
      ],
      leaveTypes: LEAVE_TYPES,
      year: 2026,
    })
    expect(dupes[0].status).toBe("AMBIGUOUS_NAME")
    expect(dupes[0].email).toBeNull()
  })

  it("reports an unknown employee rather than inventing an email", () => {
    const none = convertPandaRows({
      rows: parsed.rows,
      employees: [],
      leaveTypes: LEAVE_TYPES,
      year: 2026,
    })
    expect(none[0].status).toBe("NO_EMAIL_MATCH")
    expect(none[0].email).toBeNull()
  })

  it("folds amendments into entitled", () => {
    const amended = convertPandaRows({
      rows: [{ ...parsed.rows[0], amendments: 2 }],
      employees: EMPLOYEES,
      leaveTypes: LEAVE_TYPES,
      year: 2026,
    })
    expect(amended[0].entitled).toBe(10)
    expect(amended[0].notes.join(" ")).toContain("Amendments")
  })
})

describe("toHrBalanceCsv", () => {
  it("emits only READY rows, under the importer's header", () => {
    const parsed = parsePayrollPandaSheet(SHEET)
    const csv = toHrBalanceCsv(
      convertPandaRows({
        rows: parsed.rows,
        employees: EMPLOYEES,
        leaveTypes: LEAVE_TYPES,
        year: 2026,
      }),
    )
    const lines = csv.split("\r\n")
    expect(lines[0]).toBe(
      "Employee Email,Leave Type,Year,Entitled Days,Carried Forward,Taken",
    )
    // 3 READY rows: two for Chan, one for Hooi. The empty row and the
    // unmatched Time Off In Lieu row are excluded.
    expect(lines).toHaveLength(4)
    expect(lines[1]).toBe("chan@acme.my,Annual Leave,2026,8,0,7")
    // The header must keep containing "entitled" — that is what routes
    // the upload to the balances importer rather than history.
    expect(lines[0].toLowerCase()).toContain("entitled")
  })

  it("quotes a leave type containing a comma", () => {
    const csv = toHrBalanceCsv([
      {
        sheetRow: 6, fullName: "A", memberCode: "", policy: "x",
        email: "a@b.my", leaveTypeName: "Leave, special", year: 2026,
        entitled: 1, carriedForward: 0, taken: 0, status: "READY", notes: [],
      },
    ])
    expect(csv.split("\r\n")[1]).toContain('"Leave, special"')
  })
})

describe("normaliseName", () => {
  it("flattens case, punctuation and spacing without reordering", () => {
    expect(normaliseName("  NURUL  ATHIRAH   Binti Aizan ")).toBe(
      "nurul athirah binti aizan",
    )
    expect(normaliseName("Lim Ser-Qi")).toBe("lim ser-qi")
  })
})
