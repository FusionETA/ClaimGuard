import { requirePortalSession } from "@/lib/auth/session"

import { ComingSoonPanel } from "../coming-soon-panel"

export default async function EmployeeClockPage() {
  await requirePortalSession("EMPLOYEE")

  return (
    <div className="attendance-module -mx-6 -my-6 px-6 py-6 lg:-my-8 lg:py-8">
      <ComingSoonPanel
        title="Clock in / out"
        description="The biometric clock screen ports here next. Tap-to-clock UI from attendance-next will live in this route."
      />
    </div>
  )
}
