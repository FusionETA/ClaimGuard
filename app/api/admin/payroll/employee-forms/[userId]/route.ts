import { NextResponse } from "next/server"

import { safeErrorMessage } from "@/lib/errors"
import {
  EMPLOYEE_FORM_KINDS,
  type EmployeeFormKind,
} from "@/modules/payroll/domain/employee-forms"
import { generateEmployeeForm } from "@/modules/payroll/application/services/payroll-employee-forms.service"

/**
 * GET /api/admin/payroll/employee-forms/[userId]?kind=PCB2II&year=2026
 *
 * Streams the requested per-employee LHDN form as an inline PDF, with
 * Content-Disposition set so the browser saves it under a predictable
 * file name (PCB2II_EMP001_2026.pdf, etc).
 *
 * Admin auth + org scoping happens inside `generateEmployeeForm`. We
 * don't try to validate auth here — the service throws a friendly
 * "Session expired" message which we surface as a 401.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const { userId } = await context.params
  const url = new URL(request.url)
  const kindRaw = url.searchParams.get("kind") ?? ""
  const yearRaw = url.searchParams.get("year") ?? ""

  if (!EMPLOYEE_FORM_KINDS.includes(kindRaw as EmployeeFormKind)) {
    return NextResponse.json(
      {
        error: `Unknown form kind: "${kindRaw}". Expected one of ${EMPLOYEE_FORM_KINDS.join(", ")}.`,
      },
      { status: 400 },
    )
  }
  const kind = kindRaw as EmployeeFormKind

  // Year is required by every form in v1 (PCB2II/TP3/CP22A/CP21 need
  // it for YTD; CP22 uses the join year for filename). Default to the
  // current calendar year when missing so a button without a picker
  // still works.
  const year =
    /^\d{4}$/.test(yearRaw) ? Number.parseInt(yearRaw, 10) : new Date().getFullYear()

  try {
    const out = await generateEmployeeForm({ userId, kind, year })
    // Convert Node Buffer → Uint8Array for NextResponse (Buffer is a
    // subclass but TS sometimes complains under stricter lib settings).
    return new NextResponse(new Uint8Array(out.buffer), {
      status: 200,
      headers: {
        "Content-Type": out.mimeType,
        "Content-Disposition": `attachment; filename="${out.fileName}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    const message = safeErrorMessage(err, "Could not generate this form.")
    // Use 401 for the session-expired hint, 404 for missing employee,
    // 422 for the active/archived gate, 500 otherwise. Cheap heuristic
    // since the service throws plain Errors — keeps the route handler
    // simple without needing a custom error class.
    const lower = message.toLowerCase()
    const status = lower.includes("session expired")
      ? 401
      : lower.includes("not found")
        ? 404
        : lower.includes("can only be generated") ||
            lower.includes("not yet implemented")
          ? 422
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
