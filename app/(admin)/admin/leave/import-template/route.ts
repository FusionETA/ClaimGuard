import { NextResponse } from "next/server"

import { getCurrentSession, resolveActiveOrgId } from "@/lib/auth/session"
import { isAdminRole } from "@/lib/auth/types"
import { listLeaveTypes } from "@/modules/leave/application/services/leave-types.service"
import { buildLeaveHistoryTemplateBuffer } from "@/modules/leave/application/services/report-renderers/leave-history-template"

/**
 * GET /admin/leave/import-template
 *
 * Streams the styled XLSX template for the leave-history importer. The
 * org's live leave-type names are pre-loaded into the Leave Type dropdown
 * so admins pick valid values.
 */
export async function GET() {
  const session = await getCurrentSession()
  if (!session || !isAdminRole(session.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const orgId = resolveActiveOrgId(session)
  if (!orgId) {
    return NextResponse.json({ error: "No active organisation." }, { status: 400 })
  }

  const types = await listLeaveTypes(orgId)
  const buffer = await buildLeaveHistoryTemplateBuffer({
    leaveTypeNames: types.map((t) => t.name),
  })
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        'attachment; filename="leave-history-import-template.xlsx"',
      "Cache-Control": "no-store",
    },
  })
}
