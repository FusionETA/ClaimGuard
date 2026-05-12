import { NextResponse } from "next/server"

/**
 * GET /admin/payroll/employees/import-template
 *
 * Streams the canonical CSV template for bulk employee imports.
 * Required columns are prefixed with `*` in the header row so admins
 * can see at a glance which fields are mandatory.
 *
 * Two example rows are pre-filled so non-technical HR can pattern-
 * match the formats. The comment row at the top documents the
 * accepted values.
 */
export async function GET() {
  const csv = buildTemplateCsv()
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="payroll-employee-import-template.csv"',
      "Cache-Control": "no-store",
    },
  })
}

/**
 * Column metadata for the template. `required: true` columns are
 * prefixed with `*` in the header — anything else is optional.
 * Order: required first, then statutory, then bank, then optional.
 */
type Column = {
  key: string
  required: boolean
  description: string
}

const COLUMNS: Column[] = [
  // Tier 1 — identity (required)
  { key: "name", required: true, description: "Full legal name" },
  { key: "email", required: true, description: "Login email, must be unique in the org" },
  { key: "employeeId", required: true, description: "Org-specific employee code, e.g. EMP-001" },
  { key: "jobTitle", required: true, description: "Free-text job title" },
  // Tier 2 — payroll-readiness (required)
  { key: "salaryType", required: true, description: "MONTHLY or HOURLY" },
  { key: "monthlySalary", required: false, description: "MYR — required if salaryType=MONTHLY" },
  { key: "hourlyRate", required: false, description: "MYR — required if salaryType=HOURLY" },
  { key: "joinDate", required: true, description: "YYYY-MM-DD; required for proration" },
  { key: "nationality", required: true, description: "Malaysian / Indonesian / etc." },
  { key: "dateOfBirth", required: true, description: "YYYY-MM-DD; default password = email + MMDD" },
  // Tier 3 — statutory (optional)
  { key: "hasPr", required: false, description: "TRUE/FALSE — Permanent Resident flag" },
  { key: "idType", required: false, description: "NRIC | PASSPORT | ARMY_NO | POLICE_NO" },
  { key: "idNumber", required: false, description: "Identification number" },
  { key: "epfNumber", required: false, description: "KWSP member number" },
  { key: "epfMemberBefore1998", required: false, description: "TRUE/FALSE — drives Part A/C vs Part F" },
  { key: "socsoScheme", required: false, description: "EMPLOYMENT_INJURY_INVALIDITY | EMPLOYMENT_INJURY_ONLY | (blank for none)" },
  { key: "socsoNumber", required: false, description: "PERKESO number" },
  { key: "contributeToEis", required: false, description: "TRUE/FALSE — default TRUE for Malaysians" },
  { key: "incomeTaxNumber", required: false, description: "LHDN PCB number; PCB stays 0 until this is filled" },
  { key: "isResident", required: false, description: "TRUE/FALSE — tax resident status, default TRUE" },
  { key: "isOku", required: false, description: "TRUE/FALSE — OKU (disabled) status" },
  // Tier 4 — bank (optional, needed for bank disbursement CSV)
  { key: "bankName", required: false, description: "e.g. Maybank, CIMB, RHB" },
  { key: "bankAccountHolderName", required: false, description: "Defaults to employee name if blank" },
  { key: "bankAccountNumber", required: false, description: "Account number" },
  { key: "paymentMethod", required: false, description: "BANK_TRANSFER | CASH | CHEQUE (default BANK_TRANSFER)" },
  // Tier 5 — optional supplementary
  { key: "phone", required: false, description: "Contact phone" },
  { key: "gender", required: false, description: "MALE | FEMALE" },
  { key: "race", required: false, description: "LHDN race code (M/C/I/O)" },
  { key: "maritalStatus", required: false, description: "SINGLE | MARRIED | DIVORCED | WIDOWED" },
  { key: "addressLine1", required: false, description: "Street address line 1" },
  { key: "addressLine2", required: false, description: "Street address line 2" },
  { key: "city", required: false, description: "City" },
  { key: "postcode", required: false, description: "Postcode" },
  { key: "state", required: false, description: "State" },
  { key: "department", required: false, description: "Free-text department label" },
  { key: "location", required: false, description: "Free-text work location" },
  // Hierarchy (optional)
  { key: "projectCode", required: false, description: "Project code to assign to" },
  { key: "teamCode", required: false, description: "Team code within the project" },
  { key: "supervisorEmployeeId", required: false, description: "Supervisor's employeeId" },
]

function buildTemplateCsv(): string {
  const headerCells = COLUMNS.map((c) =>
    csvField((c.required ? "*" : "") + c.key),
  )
  const commentCells = COLUMNS.map((c) => csvField(c.description))

  const lines: string[] = []
  // Two-row template: header + description. No example rows — admins
  // fill in their data starting at row 3.
  lines.push(headerCells.join(","))
  lines.push(commentCells.map((c, i) => (i === 0 ? "# " + c : c)).join(","))
  // BOM for Excel UTF-8 friendliness.
  return "﻿" + lines.join("\r\n") + "\r\n"
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
