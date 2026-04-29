import { requirePortalSession } from "@/lib/auth/session"

import { ComingSoonPanel } from "../coming-soon-panel"

export default async function EmployeeClockPage() {
  await requirePortalSession("EMPLOYEE")

  return (
    <ComingSoonPanel
      title="Clock in / out"
      description="The biometric clock screen ports here next. Tap-to-clock UI from attendance-next will live in this route."
    />
  )
}
