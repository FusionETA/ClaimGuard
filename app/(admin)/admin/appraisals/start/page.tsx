import { redirect } from "next/navigation"

import { getCurrentSession } from "@/lib/auth/session"
import { getStartAppraisalPageData } from "@/modules/appraisify/application/services/appraisal-page-data.service"

import { StartAppraisalClient } from "./start-appraisal-client"

// The admin group layout already enforces the ADMIN role (accepts OWNER);
// this page only needs a session-existence check — see
// modules/appraisify/CLAUDE.md.
export default async function StartAppraisalPage({
  searchParams,
}: {
  searchParams: Promise<{ employees?: string }>
}) {
  const session = await getCurrentSession()
  if (!session) redirect("/login")

  const { employees: employeesParam } = await searchParams
  const employeeIds = (employeesParam ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  const data = await getStartAppraisalPageData(employeeIds)
  if (!data) redirect("/login")

  // Computed server-side and passed as a prop (not client-side `new Date()`)
  // so the initial year selection is identical on the server render and the
  // client hydration pass — see app/CLAUDE.md's hydration-safety note.
  const currentYear = new Date().getFullYear()

  return <StartAppraisalClient data={data} currentYear={currentYear} />
}
